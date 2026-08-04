/**
 * zen-fs-sync — SyncPair 核心类
 *
 * 管理一对文件系统之间的同步逻辑，包括：
 * - 单次手动同步
 * - watch 模式（轮询 + 防抖）
 * - 事件通知
 * - 快照持久化（用于增量检测）
 */

import {
  ChangeType,
  ConflictStrategy,
  SyncDirection,
  SyncEventType,
  SyncPairState,
  type ChangeDetector,
  type ChangeEntry,
  type ConflictEntry,
  type ConflictResolver,
  type FileSnapshot,
  type SyncEvent,
  type SyncEventHandler,
  type SyncFilter,
  type SyncOptions,
  type ResolvedSyncOptions,
  type SyncPairStatus,
  type SyncResult,
  type SyncableFS,
} from './types';
import { IncrementalDetector } from './detector/incremental';
import { DefaultConflictResolver } from './strategy/default';
import {
  buildSnapshot,
  ensureDir,
  generatePairId,
  normalizePath,
  resolvePath,
  writeFileWithMtimeFallback,
} from './utils';
import { createLogger } from './logger';

const log = createLogger('sync');

export class SyncPair {
  readonly pairId: string;
  readonly source: SyncableFS;
  readonly target: SyncableFS;
  readonly root: string;

  private readonly options: ResolvedSyncOptions;
  private readonly detector: ChangeDetector;
  private readonly resolver: ConflictResolver;

  private state: SyncPairState = SyncPairState.Idle;
  private lastResult?: SyncResult;
  private lastCheckTime?: number;
  private totalSyncs = 0;
  // 轮询定时器列表（远程 shouldSync 轮询，或两端都不支持变更检测时的兜底轮询）
  private pollTimers: NodeJS.Timer[] = [];
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Map<SyncEventType, Set<SyncEventHandler>>();
  private sourceSnapshots?: Map<string, FileSnapshot>;

  constructor(
    source: SyncableFS,
    target: SyncableFS,
    options: SyncOptions = {},
    private readonly syncRoot: string = '/',
  ) {
    this.pairId = generatePairId();
    this.source = source;
    this.target = target;
    this.root = normalizePath(syncRoot);

    // 合并默认选项
    this.options = {
      direction: options.direction ?? SyncDirection.OneWay,
      conflictStrategy: options.conflictStrategy ?? ConflictStrategy.SourceWins,
      debounceMs: options.debounceMs ?? 300,
      pollIntervalMs: options.pollIntervalMs ?? 30 * 60 * 1000, // 30 min
      filter: options.filter,
    };

    // 检测器：watch 模式用增量，手动模式用全量
    this.detector = new IncrementalDetector();
    this.resolver = new DefaultConflictResolver();

    log(`pair ${this.pairId} created: root=${this.root} dir=${this.options.direction} source=${source.backendName || '?'} target=${target.backendName || '?'}`);
  }

  // -----------------------------------------------------------------------
  // 手动同步
  // -----------------------------------------------------------------------

  /**
   * 执行一次同步。
   */
  async sync(): Promise<SyncResult> {
    if (this.state === SyncPairState.Disposed) {
      throw new Error(`SyncPair ${this.pairId} has been disposed`);
    }
    if (this.state === SyncPairState.Syncing) {
      return this.lastResult!;
    }

    const startTime = Date.now();
    this.state = SyncPairState.Syncing;
    this.lastCheckTime = Date.now();
    this.emit({ type: 'sync:start', pairId: this.pairId, timestamp: Date.now() });

    try {
      let result: SyncResult;

      if (this.options.direction === SyncDirection.BiDirectional) {
        result = await this.syncBidirectional();
      } else {
        result = await this.syncOneWay(this.source, this.target, 'source→target');
      }

      result.durationMs = Date.now() - startTime;
      this.lastResult = result;
      this.totalSyncs++;
      // 有轮询定时器则保持 Watching，否则回到 Idle
      this.state = this.pollTimers.length > 0 ? SyncPairState.Watching : SyncPairState.Idle;

      // Only log when there's actual activity (created/updated/deleted/conflicts)
      const hasActivity = result.filesCreated > 0 || result.filesUpdated > 0 || result.filesDeleted > 0 || result.conflicts.length > 0;
      if (hasActivity) {
        console.log(`[zen-fs-sync] sync pairId=${this.pairId} +${result.filesCreated}/~${result.filesUpdated}/-${result.filesDeleted} skip:${result.filesSkipped} conflicts:${result.conflicts.length} ${result.durationMs}ms`);
      }

      this.emit({
        type: 'sync:end',
        pairId: this.pairId,
        timestamp: Date.now(),
        result,
      });

      return result;
    } catch (error) {
      // 有轮询定时器则保持 Watching，否则回到 Idle
      this.state = this.pollTimers.length > 0 ? SyncPairState.Watching : SyncPairState.Idle;
      console.error(`[zen-fs-sync] sync ERROR pairId=${this.pairId}`, error);
      this.emit({
        type: 'sync:error',
        pairId: this.pairId,
        timestamp: Date.now(),
        error: error instanceof Error ? error : new Error(String(error)),
      });
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Watch 模式
  // -----------------------------------------------------------------------

  /**
   * 启动自动监听同步。
   *
   * 混合模式：
   * - 本地端通过 onChange 回调主动推送变更（防抖触发同步）
   * - 远程端通过定时轮询 shouldSync 检测外部变更
   * - 兜底：两端都不支持 onChange 也不支持 shouldSync 时，退化为传统轮询
   */
  watch(): void {
    if (this.state === SyncPairState.Disposed) {
      throw new Error(`SyncPair ${this.pairId} has been disposed`);
    }
    // 已经在 watch（处于 Watching 状态或已有轮询定时器），直接返回
    if (this.state === SyncPairState.Watching || this.pollTimers.length > 0) return;

    this.state = SyncPairState.Watching;
    log(`watch:start ${this.pairId}`);
    this.emit({ type: 'watch:start', pairId: this.pairId, timestamp: Date.now() });

    // 注册 onChange 回调（本地端通过回调主动推送变更）
    this.source.onChange?.(() => this.onLocalChange());
    this.target.onChange?.(() => this.onLocalChange());

    // 远程端轮询 shouldSync（只有实现了 shouldSync 的端才轮询）
    this.buildInitialSnapshots().then(() => {
      const intervalMs = this.options.pollIntervalMs;
      const timers: NodeJS.Timer[] = [];

      if (this.source.shouldSync) {
        timers.push(setInterval(() => this.onRemotePoll(), intervalMs) as unknown as NodeJS.Timer);
      }
      if (this.target.shouldSync) {
        timers.push(setInterval(() => this.onRemotePoll(), intervalMs) as unknown as NodeJS.Timer);
      }

      // 兜底：如果两端都不支持 shouldSync 也不支持 onChange，用传统轮询
      if (timers.length === 0 && !this.source.onChange && !this.target.onChange) {
        timers.push(setInterval(() => this.onLocalChange(), intervalMs) as unknown as NodeJS.Timer);
      }

      this.pollTimers = timers;

      log(
        `watch:start ${this.pairId} interval=${intervalMs}ms ` +
          `onChange=[src=${!!this.source.onChange}, tgt=${!!this.target.onChange}] ` +
          `shouldSync=[src=${!!this.source.shouldSync}, tgt=${!!this.target.shouldSync}]`,
      );
    }).catch((err) => {
      log(`watch:init-snapshots failed ${this.pairId}`, err);
    });
  }

  /**
   * 停止自动监听。
   *
   * Always clears all state (timers, debounce, snapshots) even if no poll
   * timers were set yet. This is critical: buildInitialSnapshots() runs
   * asynchronously inside watch(), and if unwatch() is called before that
   * async work completes, we must still clear sourceSnapshots so that the
   * next syncAll() performs a full comparison instead of skipping due to
   * a stale cached snapshot.
   */
  unwatch(): void {
    // 清理所有轮询定时器
    for (const timer of this.pollTimers) {
      clearInterval(timer as unknown as number);
    }
    this.pollTimers = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    // Clear cached snapshots so the next sync() does a full comparison.
    // Without this, buildInitialSnapshots() may have already cached a
    // merged (source ∪ target) snapshot WITHOUT actually syncing files,
    // causing syncBidirectional() to see "unchanged" and skip.
    this.sourceSnapshots = undefined;

    // Only log/emit if we were actually watching (state was Watching or had timers)
    if (this.state === SyncPairState.Watching) {
      this.state = SyncPairState.Idle;
      log(`watch:stop ${this.pairId}`);
      this.emit({ type: 'watch:stop', pairId: this.pairId, timestamp: Date.now() });
    } else {
      // Still set state to Idle in case it was left in an intermediate state
      this.state = SyncPairState.Idle;
    }
  }

  // -----------------------------------------------------------------------
  // 状态查询
  // -----------------------------------------------------------------------

  getStatus(): SyncPairStatus {
    return {
      pairId: this.pairId,
      sourceName: (this.source as any).backendName,
      targetName: (this.target as any).backendName,
      state: this.state,
      lastResult: this.lastResult,
      lastCheckTime: this.lastCheckTime,
      // 是否正在 watch：有轮询定时器或处于 Watching 状态
      watching: this.pollTimers.length > 0 || this.state === SyncPairState.Watching,
      totalSyncs: this.totalSyncs,
    };
  }

  // -----------------------------------------------------------------------
  // 生命周期
  // -----------------------------------------------------------------------

  /**
   * 销毁同步对，停止 watch 并释放资源。
   */
  dispose(): void {
    this.unwatch();
    this.state = SyncPairState.Disposed;
    this.listeners.clear();
    this.sourceSnapshots = undefined;
    log(`disposed ${this.pairId}`);
  }

  // -----------------------------------------------------------------------
  // 事件
  // -----------------------------------------------------------------------

  on(event: SyncEventType, handler: SyncEventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: SyncEventType, handler: SyncEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  private emit(event: SyncEvent): void {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const h of handlers) {
        try {
          h(event);
        } catch {
          // listener 错误不影响同步流程
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // 内部实现
  // -----------------------------------------------------------------------

  private async syncOneWay(
    src: SyncableFS,
    tgt: SyncableFS,
    directionLabel: string,
  ): Promise<SyncResult> {
    const changes = await this.detector.detect(
      src,
      tgt,
      this.root,
      this.sourceSnapshots,
      this.options.filter,
    );

    if (changes.length > 0) {
      console.log(`[zen-fs-sync] syncOneWay START direction=${directionLabel} changes=${changes.length}`);
    }

    // 更新快照 — only if the source is reachable (not null).
    // If buildSnapshot returns null, keep the previous snapshot to avoid
    // treating an unreachable FS as "all files deleted" on the next cycle.
    const newSnap = await buildSnapshot(src, this.root, this.options.filter);
    if (newSnap !== null) {
      this.sourceSnapshots = newSnap;
    }

    let filesCreated = 0;
    let filesUpdated = 0;
    let filesDeleted = 0;
    let filesSkipped = 0;
    const conflicts: ConflictEntry[] = [];

    for (const change of changes) {
      const srcPath = resolvePath(this.root, change.path);
      const tgtPath = resolvePath(this.root, change.path);

      switch (change.type) {
        case ChangeType.Created:
        case ChangeType.Modified: {
          const isCreated = change.type === ChangeType.Created;
          // 检查双向冲突：Modified 时目标端也有不同版本
          if (change.type === ChangeType.Modified) {
            const srcContent = await src.readFile(srcPath, 'utf-8');
            const tgtContent = await tgt.readFile(tgtPath, 'utf-8');
            if (srcContent !== tgtContent) {
              const resolved = await this.resolver.resolve(
                change.path,
                srcContent,
                tgtContent,
                this.options.conflictStrategy,
              );
              const conflict: ConflictEntry = {
                path: change.path,
                sourceContent: srcContent,
                targetContent: tgtContent,
                resolvedWith: resolved.strategy,
                mergedContent:
                  resolved.strategy === ConflictStrategy.Merge
                    ? resolved.content
                    : undefined,
              };
              conflicts.push(conflict);
              this.emit({
                type: 'conflict',
                pairId: this.pairId,
                timestamp: Date.now(),
                conflict,
              });

              if (isCreated) filesCreated++;
              else filesUpdated++;

              await ensureDir(tgt, tgtPath.substring(0, tgtPath.lastIndexOf('/')));
              // Preserve source mtime when writing resolved content
              let resolvedMtime: number | undefined;
              try {
                const srcStat = await src.stat(srcPath);
                resolvedMtime = srcStat.mtimeMs;
              } catch { /* source may be gone */ }
              await writeFileWithMtimeFallback(tgt, tgtPath, resolved.content, resolvedMtime);
              continue;
            }
          }

          try {
            const srcContent = await src.readFile(srcPath, 'utf-8');
            // Content comparison: skip write if target already has identical content
            try {
              const tgtContent = await tgt.readFile(tgtPath, 'utf-8');
              if (srcContent === tgtContent) {
                console.log(`[zen-fs-sync] WRITE SKIP (content identical) ${change.path}`);
                filesSkipped++;
                break;
              }
            } catch {
              // target doesn't exist — proceed
            }
            console.log(`[zen-fs-sync] WRITE ${change.type} [${directionLabel}] ${srcPath} → ${tgtPath} (${srcContent.length} chars)`);
            await ensureDir(tgt, tgtPath.substring(0, tgtPath.lastIndexOf('/')));
            // Preserve source mtime when copying
            let srcMtime: number | undefined;
            try {
              const srcStat = await src.stat(srcPath);
              srcMtime = srcStat.mtimeMs;
            } catch { /* source may be gone */ }
            await writeFileWithMtimeFallback(tgt, tgtPath, srcContent, srcMtime);
            if (isCreated) filesCreated++;
            else filesUpdated++;
          } catch (err) {
            console.error(`[zen-fs-sync] WRITE FAIL ${change.type} [${directionLabel}] ${srcPath} → ${tgtPath}:`, err);
            filesSkipped++;
          }
          break;
        }

        case ChangeType.Deleted: {
          try {
            console.log(`[zen-fs-sync] DELETE [${directionLabel}] ${tgtPath}`);
            await tgt.unlink(tgtPath);
            filesDeleted++;
          } catch (err) {
            console.warn(`[zen-fs-sync] DELETE SKIP [${directionLabel}] ${tgtPath}:`, err);
            filesSkipped++;
          }
          break;
        }
      }
    }

    return {
      pairId: this.pairId,
      direction: this.options.direction,
      timestamp: Date.now(),
      filesCreated,
      filesUpdated,
      filesDeleted,
      filesSkipped,
      conflicts,
      changes,
      durationMs: 0, // 由 sync() 方法填充
    };
  }

  private async syncBidirectional(): Promise<SyncResult> {
    const startTime = Date.now();

    const [srcSnap, tgtSnap] = await Promise.all([
      buildSnapshot(this.source, this.root, this.options.filter),
      buildSnapshot(this.target, this.root, this.options.filter),
    ]);

    if (srcSnap === null || tgtSnap === null) {
      console.log(`[zen-fs-sync] syncBidirectional SKIP (one side unreachable)`);
      return {
        pairId: this.pairId,
        direction: SyncDirection.BiDirectional,
        timestamp: Date.now(),
        filesCreated: 0, filesUpdated: 0, filesDeleted: 0, filesSkipped: 0,
        conflicts: [], changes: [], durationMs: Date.now() - startTime,
      };
    }

    // 快照快速比较：将当前两端合并快照与上次的合并快照比较。
    // 如果完全一致（路径、mtime、size 都没变），说明两端都没有变化，跳过同步。
    const currentMerged = new Map<string, FileSnapshot>([...srcSnap, ...tgtSnap]);
    if (this.sourceSnapshots && this.sourceSnapshots.size === currentMerged.size) {
      let unchanged = true;
      for (const [path, entry] of currentMerged) {
        const prev = this.sourceSnapshots.get(path);
        if (!prev || prev.mtimeMs !== entry.mtimeMs || prev.size !== entry.size) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) {
        const durationMs = Date.now() - startTime;
        return {
          pairId: this.pairId,
          direction: SyncDirection.BiDirectional,
          timestamp: Date.now(),
          filesCreated: 0, filesUpdated: 0, filesDeleted: 0, filesSkipped: 0,
          conflicts: [], changes: [], durationMs,
        };
      }
    }

    // 保存本次合并快照供下次比较
    this.sourceSnapshots = currentMerged;

    const srcPaths = Array.from(srcSnap.keys()).sort();
    const tgtPaths = Array.from(tgtSnap.keys()).sort();
    console.log(`[zen-fs-sync] syncBidirectional comparing source=${srcPaths.length} target=${tgtPaths.length}`);

    let filesCreated = 0;
    let filesUpdated = 0;
    let filesDeleted = 0;
    let filesSkipped = 0;
    const conflicts: ConflictEntry[] = [];
    const changes: ChangeEntry[] = [];

    const allPaths = new Set([...srcSnap.keys(), ...tgtSnap.keys()]);

    for (const path of allPaths) {
      const srcEntry = srcSnap.get(path);
      const tgtEntry = tgtSnap.get(path);

      if (!srcEntry && tgtEntry) {
        // Only on target → copy to source
        try {
          const wrote = await this.copyFile(this.target, this.source, path);
          if (wrote) {
            filesCreated++;
            changes.push({ path, type: ChangeType.Created, sourceSnapshot: tgtEntry });
            console.log(`[zen-fs-sync] COPY target→source ${path}`);
          } else {
            filesSkipped++;
          }
        } catch (err) {
          console.error(`[zen-fs-sync] COPY FAIL target→source ${path}:`, err);
          filesSkipped++;
        }
      } else if (srcEntry && !tgtEntry) {
        // Only on source → copy to target
        try {
          const wrote = await this.copyFile(this.source, this.target, path);
          if (wrote) {
            filesCreated++;
            changes.push({ path, type: ChangeType.Created, sourceSnapshot: srcEntry });
            console.log(`[zen-fs-sync] COPY source→target ${path}`);
          } else {
            filesSkipped++;
          }
        } catch (err) {
          console.error(`[zen-fs-sync] COPY FAIL source→target ${path}:`, err);
          filesSkipped++;
        }
      } else if (srcEntry && tgtEntry) {
        // Both have it — compare mtime
        if (srcEntry.mtimeMs === tgtEntry.mtimeMs && srcEntry.size === tgtEntry.size) {
          continue; // Identical
        }

        if (srcEntry.mtimeMs > tgtEntry.mtimeMs) {
          try {
            const wrote = await this.copyFile(this.source, this.target, path);
            if (wrote) {
              filesUpdated++;
              changes.push({ path, type: ChangeType.Modified, sourceSnapshot: srcEntry, targetSnapshot: tgtEntry });
              console.log(`[zen-fs-sync] UPDATE source→target ${path} (src newer mtime=${srcEntry.mtimeMs} > tgt=${tgtEntry.mtimeMs})`);
            } else {
              filesSkipped++;
            }
          } catch (err) {
            console.error(`[zen-fs-sync] UPDATE FAIL source→target ${path}:`, err);
            filesSkipped++;
          }
        } else if (tgtEntry.mtimeMs > srcEntry.mtimeMs) {
          try {
            const wrote = await this.copyFile(this.target, this.source, path);
            if (wrote) {
              filesUpdated++;
              changes.push({ path, type: ChangeType.Modified, sourceSnapshot: tgtEntry, targetSnapshot: srcEntry });
              console.log(`[zen-fs-sync] UPDATE target→source ${path} (tgt newer mtime=${tgtEntry.mtimeMs} > src=${srcEntry.mtimeMs})`);
            } else {
              filesSkipped++;
            }
          } catch (err) {
            console.error(`[zen-fs-sync] UPDATE FAIL target→source ${path}:`, err);
            filesSkipped++;
          }
        } else {
          // Same mtime but different size — conflict
          const srcContent = await this.source.readFile(resolvePath(this.root, path), 'utf-8');
          const tgtContent = await this.target.readFile(resolvePath(this.root, path), 'utf-8');
          if (srcContent === tgtContent) {
            continue; // Content identical despite size mismatch (encoding?)
          }
          const resolved = await this.resolver.resolve(
            path, srcContent, tgtContent, this.options.conflictStrategy,
          );
          conflicts.push({
            path,
            sourceContent: srcContent,
            targetContent: tgtContent,
            resolvedWith: resolved.strategy,
            mergedContent: resolved.strategy === ConflictStrategy.Merge ? resolved.content : undefined,
          });
          await this.writeFileBoth(path, resolved.content);
          filesUpdated++;
          changes.push({ path, type: ChangeType.Modified, sourceSnapshot: { ...srcEntry, mtimeMs: Date.now() }, targetSnapshot: srcEntry });
          console.log(`[zen-fs-sync] CONFLICT ${path} resolved=${resolved.strategy}`);
        }
      }
    }

    const durationMs = Date.now() - startTime;
    console.log(`[zen-fs-sync] syncBidirectional END pairId=${this.pairId} +${filesCreated}/~${filesUpdated}/-${filesDeleted} ${durationMs}ms`);

    return {
      pairId: this.pairId,
      direction: SyncDirection.BiDirectional,
      timestamp: Date.now(),
      filesCreated,
      filesUpdated,
      filesDeleted,
      filesSkipped,
      conflicts,
      changes,
      durationMs,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async copyFile(from: SyncableFS, to: SyncableFS, relPath: string): Promise<boolean> {
    const fullPath = resolvePath(this.root, relPath);
    const srcContent = await from.readFile(fullPath, 'utf-8');
    // Content comparison: skip write if target already has identical content
    try {
      const tgtContent = await to.readFile(fullPath, 'utf-8');
      if (srcContent === tgtContent) {
        return false; // no write needed
      }
    } catch {
      // target file doesn't exist — proceed with write
    }
    await ensureDir(to, fullPath.substring(0, fullPath.lastIndexOf('/')));
    // Preserve source mtime when copying
    let srcMtime: number | undefined;
    try {
      const srcStat = await from.stat(fullPath);
      srcMtime = srcStat.mtimeMs;
    } catch { /* source may be gone */ }
    await writeFileWithMtimeFallback(to, fullPath, srcContent, srcMtime);
    return true; // wrote
  }

  private async writeFileBoth(relPath: string, content: string): Promise<void> {
    const fullPath = resolvePath(this.root, relPath);
    await ensureDir(this.source, fullPath.substring(0, fullPath.lastIndexOf('/')));
    await ensureDir(this.target, fullPath.substring(0, fullPath.lastIndexOf('/')));
    // Use current time as mtime for conflict resolution (both sides get same mtime)
    const now = Date.now();
    await writeFileWithMtimeFallback(this.source, fullPath, content, now);
    await writeFileWithMtimeFallback(this.target, fullPath, content, now);
  }

  /**
   * 本地变更回调（由实现了 onChange 的后端在 writeFile/unlink 后触发）。
   * 仅做防抖调度，不直接同步。
   */
  private onLocalChange(): void {
    this.scheduleSync();
  }

  /**
   * 远程轮询：检查所有实现了 shouldSync 的端是否有外部变更。
   * 只要任一端返回 true 就触发同步；shouldSync 调用失败则兜底触发同步。
   */
  private async onRemotePoll(): Promise<void> {
    if (this.state === SyncPairState.Syncing) return;

    // 检查所有实现了 shouldSync 的端
    const checks: Promise<boolean>[] = [];
    if (this.source.shouldSync) checks.push(this.source.shouldSync());
    if (this.target.shouldSync) checks.push(this.target.shouldSync());

    if (checks.length === 0) return;

    try {
      const results = await Promise.all(checks);
      // 只要任一端返回 true 就需要同步
      if (!results.some(r => r)) {
        this.lastCheckTime = Date.now();
        return;
      }
    } catch {
      // shouldSync 失败 → 执行同步作为兜底
    }

    this.scheduleSync();
  }

  /**
   * 防抖调度同步：在 debounceMs 内的多次触发只执行一次 sync。
   */
  private scheduleSync(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.sync().catch(() => {});
    }, this.options.debounceMs);
  }

  private async buildInitialSnapshots(): Promise<void> {
    if (this.options.direction === SyncDirection.BiDirectional) {
      const [srcSnap, tgtSnap] = await Promise.all([
        buildSnapshot(this.source, this.root, this.options.filter),
        buildSnapshot(this.target, this.root, this.options.filter),
      ]);
      // If either side is unreachable, skip initialization (leave undefined).
      // The next sync cycle will try again.
      if (srcSnap === null || tgtSnap === null) {
        log(`buildInitialSnapshots: one side unreachable (null) — skipping init`);
        return;
      }
      // Guard: if unwatch() was called while we were building snapshots,
      // don't cache them. The caller intends to do a fresh sync next.
      if (this.state !== SyncPairState.Watching) {
        log(`buildInitialSnapshots: state changed to ${this.state} during build — discarding snapshots`);
        return;
      }
      // 合并两个快照用于增量检测
      this.sourceSnapshots = new Map([...srcSnap, ...tgtSnap]);
    } else {
      const snap = await buildSnapshot(
        this.source,
        this.root,
        this.options.filter,
      );
      // Guard: same as above
      if (this.state !== SyncPairState.Watching) {
        log(`buildInitialSnapshots: state changed to ${this.state} during build — discarding snapshots`);
        return;
      }
      if (snap !== null) {
        this.sourceSnapshots = snap;
      } else {
        log(`buildInitialSnapshots: source unreachable (null) — skipping init`);
      }
    }
  }
}
