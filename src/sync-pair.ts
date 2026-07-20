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
      throw new Error(`SyncPair ${this.pairId} is already syncing`);
    }

    const startTime = Date.now();
    this.state = SyncPairState.Syncing;
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

      log(`sync:end ${this.pairId} +${result.filesCreated}/~${result.filesUpdated}/-${result.filesDeleted} skip:${result.filesSkipped} changes:${result.changes.length} ${result.durationMs}ms`);

      this.emit({
        type: 'sync:end',
        pairId: this.pairId,
        timestamp: Date.now(),
        result,
      });

      return result;
    } catch (error) {
      this.state = this.watchers ? SyncPairState.Watching : SyncPairState.Idle;
      log(`sync:error ${this.pairId}`, error);
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

    // 构建初始快照用于增量检测
    this.buildInitialSnapshots().catch(() => {});

    const intervalMs = Math.max(this.options.debounceMs, 500);

    this.watchers = {
      source: setInterval(() => this.onPoll(), intervalMs) as unknown as NodeJS.Timer,
      target:
        this.options.direction === SyncDirection.BiDirectional
          ? (setInterval(() => this.onPoll(), intervalMs) as unknown as NodeJS.Timer)
          : (null as unknown as NodeJS.Timer),
    };

    this.state = SyncPairState.Watching;
    log(`watch:start ${this.pairId} interval=${intervalMs}ms`);
    this.emit({ type: 'watch:start', pairId: this.pairId, timestamp: Date.now() });
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
    const changes = await this.detector.detect(
      src,
      tgt,
      this.root,
      this.sourceSnapshots,
      this.options.filter,
    );

    // 更新快照
    this.sourceSnapshots = await buildSnapshot(src, this.root, this.options.filter);

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
            log(`WRITE ${change.type} ${srcPath} → ${tgtPath} (${content.length} bytes)`);
            await ensureDir(tgt, tgtPath.substring(0, tgtPath.lastIndexOf('/')));
            await tgt.writeFile(tgtPath, content);
            if (isCreated) filesCreated++;
            else filesUpdated++;
          } catch (err) {
            log(`WRITE FAIL ${change.type} ${srcPath} → ${tgtPath}:`, err);
            filesSkipped++;
          }
          break;
        }

        case ChangeType.Deleted: {
          try {
            log(`DELETE ${tgtPath}`);
            await tgt.unlink(tgtPath);
            filesDeleted++;
          } catch (err) {
            log(`DELETE FAIL ${tgtPath}:`, err);
            // 目标端不存在则跳过
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
    // 先 source → target
    const forward = await this.syncOneWay(this.source, this.target, 'source→target');
    // 再 target → source
    const reverse = await this.syncOneWay(this.target, this.source, 'target→source');

    return {
      pairId: this.pairId,
      direction: SyncDirection.BiDirectional,
      timestamp: Date.now(),
      filesCreated: forward.filesCreated + reverse.filesCreated,
      filesUpdated: forward.filesUpdated + reverse.filesUpdated,
      filesDeleted: forward.filesDeleted + reverse.filesDeleted,
      filesSkipped: forward.filesSkipped + reverse.filesSkipped,
      conflicts: [...forward.conflicts, ...reverse.conflicts],
      changes: [...forward.changes, ...reverse.changes],
      durationMs: 0,
    };
  }

  private async onPoll(): Promise<void> {
    if (this.state === SyncPairState.Syncing) return;

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
      // 合并两个快照用于增量检测
      this.sourceSnapshots = new Map([...srcSnap, ...tgtSnap]);
      log(`initial snapshots: source=${srcSnap.size}, target=${tgtSnap.size}`);
    } else {
      this.sourceSnapshots = await buildSnapshot(
        this.source,
        this.root,
        this.options.filter,
      );
      log(`initial snapshots: source=${this.sourceSnapshots.size}`);
    }
  }
}
