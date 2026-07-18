/**
 * zen-fs-sync — ZenFSSync 管理器
 *
 * 顶层入口，管理多个 SyncPair 的生命周期。
 * 提供创建、查询、批量操作的便捷方法。
 */

import { SyncPair } from './sync-pair';
import {
  SyncDirection,
  SyncPairState,
  type SyncEventHandler,
  type SyncOptions,
  type SyncPairStatus,
  type SyncResult,
  type SyncableFS,
  type SyncEvent,
} from './types';

export class ZenFSSync {
  private pairs = new Map<string, SyncPair>();

  // -----------------------------------------------------------------------
  // 创建同步对
  // -----------------------------------------------------------------------

  /**
   * 创建一个同步对并注册到管理器。
   *
   * @param source  源文件系统（满足 SyncableFS 接口）
   * @param target  目标文件系统
   * @param options 同步选项
   * @param root    同步根路径，默认 '/'
   * @returns SyncPair 实例
   */
  addPair(
    source: SyncableFS,
    target: SyncableFS,
    options?: SyncOptions,
    root?: string,
  ): SyncPair {
    const pair = new SyncPair(source, target, options, root);
    this.pairs.set(pair.pairId, pair);
    return pair;
  }

  // -----------------------------------------------------------------------
  // 同步操作
  // -----------------------------------------------------------------------

  /**
   * 手动触发指定同步对的一次同步。
   */
  async sync(pairId: string): Promise<SyncResult> {
    const pair = this.getPair(pairId);
    return pair.sync();
  }

  /**
   * 同步所有已注册的对。
   * 并行执行，返回所有结果。
   */
  async syncAll(): Promise<Map<string, SyncResult>> {
    const results = new Map<string, SyncResult>();
    const entries = Array.from(this.pairs.entries());

    await Promise.all(
      entries.map(async ([id, pair]) => {
        try {
          results.set(id, await pair.sync());
        } catch (error) {
          results.set(id, {
            pairId: id,
            direction: pair.getStatus().lastResult?.direction ?? SyncDirection.OneWay,
            timestamp: Date.now(),
            filesCreated: 0,
            filesUpdated: 0,
            filesDeleted: 0,
            filesSkipped: 0,
            conflicts: [],
            changes: [],
            durationMs: 0,
          });
        }
      }),
    );

    return results;
  }

  // -----------------------------------------------------------------------
  // Watch 操作
  // -----------------------------------------------------------------------

  /**
   * 启动指定同步对的自动监听。
   */
  watch(pairId: string): void {
    this.getPair(pairId).watch();
  }

  /**
   * 停止指定同步对的自动监听。
   */
  unwatch(pairId: string): void {
    this.getPair(pairId).unwatch();
  }

  /**
   * 启动所有同步对的自动监听。
   */
  watchAll(): void {
    for (const pair of this.pairs.values()) {
      pair.watch();
    }
  }

  /**
   * 停止所有同步对的自动监听。
   */
  unwatchAll(): void {
    for (const pair of this.pairs.values()) {
      pair.unwatch();
    }
  }

  // -----------------------------------------------------------------------
  // 查询
  // -----------------------------------------------------------------------

  /**
   * 获取指定同步对的状态。
   */
  getStatus(pairId: string): SyncPairStatus {
    return this.getPair(pairId).getStatus();
  }

  /**
   * 获取所有同步对的状态。
   */
  getStatusAll(): Map<string, SyncPairStatus> {
    const statuses = new Map<string, SyncPairStatus>();
    for (const [id, pair] of this.pairs) {
      statuses.set(id, pair.getStatus());
    }
    return statuses;
  }

  /**
   * 列出所有已注册的 pairId。
   */
  listPairs(): string[] {
    return Array.from(this.pairs.keys());
  }

  // -----------------------------------------------------------------------
  // 事件
  // -----------------------------------------------------------------------

  /**
   * 为指定同步对注册事件监听。
   */
  on(pairId: string, event: string, handler: SyncEventHandler): void {
    this.getPair(pairId).on(event as any, handler);
  }

  /**
   * 移除指定同步对的事件监听。
   */
  off(pairId: string, event: string, handler: SyncEventHandler): void {
    this.getPair(pairId).off(event as any, handler);
  }

  // -----------------------------------------------------------------------
  // 生命周期
  // -----------------------------------------------------------------------

  /**
   * 移除并销毁指定同步对。
   */
  removePair(pairId: string): void {
    const pair = this.pairs.get(pairId);
    if (pair) {
      pair.dispose();
      this.pairs.delete(pairId);
    }
  }

  /**
   * 销毁管理器及所有同步对。
   */
  dispose(): void {
    for (const pair of this.pairs.values()) {
      pair.dispose();
    }
    this.pairs.clear();
  }

  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------

  private getPair(pairId: string): SyncPair {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      throw new Error(`SyncPair not found: ${pairId}`);
    }
    return pair;
  }
}