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
  private totalSyncs = 0;
  private watchers?: { source: NodeJS.Timer; target: NodeJS.Timer };
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
      filter: options.filter,
    };

    // 检测器：watch 模式用增量，手动模式用全量
    this.detector = new IncrementalDetector();
    this.resolver = new DefaultConflictResolver();

    log(`pair ${this.pairId} created: root=${this.root} dir=${this.options.direction}`);
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
      console.log(`[zen-fs-sync] sync SKIP (already syncing) pairId=${this.pairId}`);
      return this.lastResult!;
    }

    const startTime = Date.now();
    this.state = SyncPairState.Syncing;
    console.log(`[zen-fs-sync] sync START pairId=${this.pairId} direction=${this.options.direction} root=${this.root}`);
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
      this.state = this.watchers ? SyncPairState.Watching : SyncPairState.Idle;

      console.log(`[zen-fs-sync] sync END pairId=${this.pairId} +${result.filesCreated}/~${result.filesUpdated}/-${result.filesDeleted} skip:${result.filesSkipped} conflicts:${result.conflicts.length} ${result.durationMs}ms`);

      this.emit({
        type: 'sync:end',
        pairId: this.pairId,
        timestamp: Date.now(),
        result,
      });

      return result;
    } catch (error) {
      this.state = this.watchers ? SyncPairState.Watching : SyncPairState.Idle;
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
   * 使用轮询检测变更，防抖触发同步。
   */
  watch(): void {
    if (this.state === SyncPairState.Disposed) {
      throw new Error(`SyncPair ${this.pairId} has been disposed`);
    }
    if (this.watchers) return; // 已经在 watch

    this.state = SyncPairState.Watching;
    console.log(`[zen-fs-sync] watch START pairId=${this.pairId} direction=${this.options.direction} root=${this.root}`);
    log(`watch:start ${this.pairId} (building initial snapshots...)`);
    this.emit({ type: 'watch:start', pairId: this.pairId, timestamp: Date.now() });

    // Build initial snapshots BEFORE starting the poll timers.
    // This prevents the first poll from firing while snapshots are
    // still undefined (which would trigger a destructive full scan).
    this.buildInitialSnapshots().then(() => {
      const intervalMs = Math.max(this.options.debounceMs, 500);

      this.watchers = {
        source: setInterval(() => this.onPoll(), intervalMs) as unknown as NodeJS.Timer,
        target:
          this.options.direction === SyncDirection.BiDirectional
            ? (setInterval(() => this.onPoll(), intervalMs) as unknown as NodeJS.Timer)
            : (null as unknown as NodeJS.Timer),
      };

      log(`watch:start ${this.pairId} interval=${intervalMs}ms (snapshots ready)`);
    }).catch((err) => {
      log(`watch:init-snapshots failed ${this.pairId}`, err);
      // Still start polling even if snapshots fail — the next sync() call
      // will re-build snapshots via the full-scan fallback path.
      const intervalMs = Math.max(this.options.debounceMs, 500);
      this.watchers = {
        source: setInterval(() => this.onPoll(), intervalMs) as unknown as NodeJS.Timer,
        target: null as unknown as NodeJS.Timer,
      };
    });
  }

  /**
   * 停止自动监听。
   */
  unwatch(): void {
    if (!this.watchers) return;

    clearInterval(this.watchers.source as unknown as number);
    if (this.watchers.target) {
      clearInterval(this.watchers.target as unknown as number);
    }
    this.watchers = undefined;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.state = SyncPairState.Idle;
    log(`watch:stop ${this.pairId}`);
    this.emit({ type: 'watch:stop', pairId: this.pairId, timestamp: Date.now() });
  }

  // -----------------------------------------------------------------------
  // 状态查询
  // -----------------------------------------------------------------------

  getStatus(): SyncPairStatus {
    return {
      pairId: this.pairId,
      state: this.state,
      lastResult: this.lastResult,
      watching: !!this.watchers,
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
    console.log(`[zen-fs-sync] syncOneWay START direction=${directionLabel} pairId=${this.pairId}`);
    const changes = await this.detector.detect(
      src,
      tgt,
      this.root,
      this.sourceSnapshots,
      this.options.filter,
    );

    console.log(`[zen-fs-sync] syncOneWay DETECTED ${changes.length} changes (${directionLabel}):`, changes.map(c => `${c.type}:${c.path}`));

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
              await tgt.writeFile(tgtPath, resolved.content);
              continue;
            }
          }

          try {
            const content = await src.readFile(srcPath, 'utf-8');
            console.log(`[zen-fs-sync] WRITE ${change.type} [${directionLabel}] ${srcPath} → ${tgtPath} (${content.length} chars)`);
            await ensureDir(tgt, tgtPath.substring(0, tgtPath.lastIndexOf('/')));
            await tgt.writeFile(tgtPath, content);
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
    console.log(`[zen-fs-sync] syncBidirectional START pairId=${this.pairId} root=${this.root}`);
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

    // Merge snapshots for next incremental sync cycle
    this.sourceSnapshots = new Map([...srcSnap, ...tgtSnap]);

    // Log file listing from both sides
    const srcPaths = Array.from(srcSnap.keys()).sort();
    const tgtPaths = Array.from(tgtSnap.keys()).sort();
    console.log(`[zen-fs-sync] BI files on source (${srcPaths.length}): [${srcPaths.join(', ')}]`);
    console.log(`[zen-fs-sync] BI files on target (${tgtPaths.length}): [${tgtPaths.join(', ')}]`);

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
          await this.copyFile(this.target, this.source, path);
          filesCreated++;
          changes.push({ path, type: ChangeType.Created, sourceSnapshot: tgtEntry });
          console.log(`[zen-fs-sync] COPY target→source ${path}`);
        } catch (err) {
          console.error(`[zen-fs-sync] COPY FAIL target→source ${path}:`, err);
          filesSkipped++;
        }
      } else if (srcEntry && !tgtEntry) {
        // Only on source → copy to target
        try {
          await this.copyFile(this.source, this.target, path);
          filesCreated++;
          changes.push({ path, type: ChangeType.Created, sourceSnapshot: srcEntry });
          console.log(`[zen-fs-sync] COPY source→target ${path}`);
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
            await this.copyFile(this.source, this.target, path);
            filesUpdated++;
            changes.push({ path, type: ChangeType.Modified, sourceSnapshot: srcEntry, targetSnapshot: tgtEntry });
            console.log(`[zen-fs-sync] UPDATE source→target ${path} (src newer mtime=${srcEntry.mtimeMs} > tgt=${tgtEntry.mtimeMs})`);
          } catch (err) {
            console.error(`[zen-fs-sync] UPDATE FAIL source→target ${path}:`, err);
            filesSkipped++;
          }
        } else if (tgtEntry.mtimeMs > srcEntry.mtimeMs) {
          try {
            await this.copyFile(this.target, this.source, path);
            filesUpdated++;
            changes.push({ path, type: ChangeType.Modified, sourceSnapshot: tgtEntry, targetSnapshot: srcEntry });
            console.log(`[zen-fs-sync] UPDATE target→source ${path} (tgt newer mtime=${tgtEntry.mtimeMs} > src=${srcEntry.mtimeMs})`);
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

  private async copyFile(from: SyncableFS, to: SyncableFS, relPath: string): Promise<void> {
    const fullPath = resolvePath(this.root, relPath);
    const content = await from.readFile(fullPath, 'utf-8');
    await ensureDir(to, fullPath.substring(0, fullPath.lastIndexOf('/')));
    await to.writeFile(fullPath, content);
  }

  private async writeFileBoth(relPath: string, content: string): Promise<void> {
    const fullPath = resolvePath(this.root, relPath);
    await ensureDir(this.source, fullPath.substring(0, fullPath.lastIndexOf('/')));
    await ensureDir(this.target, fullPath.substring(0, fullPath.lastIndexOf('/')));
    await this.source.writeFile(fullPath, content);
    await this.target.writeFile(fullPath, content);
  }

  private async onPoll(): Promise<void> {
    if (this.state === SyncPairState.Syncing) {
      console.log(`[zen-fs-sync] onPoll SKIP (already syncing) pairId=${this.pairId}`);
      return;
    }

    // 防抖
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
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
      // 合并两个快照用于增量检测
      this.sourceSnapshots = new Map([...srcSnap, ...tgtSnap]);
      console.log(`[zen-fs-sync] initial snapshots: source=${srcSnap.size} files, target=${tgtSnap.size} files (merged=${this.sourceSnapshots.size})`);
    } else {
      const snap = await buildSnapshot(
        this.source,
        this.root,
        this.options.filter,
      );
      if (snap !== null) {
        this.sourceSnapshots = snap;
        console.log(`[zen-fs-sync] initial snapshots: source=${snap.size} files`);
      } else {
        log(`buildInitialSnapshots: source unreachable (null) — skipping init`);
      }
    }
  }
}
