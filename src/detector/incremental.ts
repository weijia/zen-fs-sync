/**
 * zen-fs-sync — 增量变更检测器
 *
 * 利用上次同步后的快照记录（sourceSnapshotMap），
 * 只对比当前源端快照与上次源端快照的差异，避免每次扫描目标端。
 * 适用于 watch 模式下高频同步。
 */

import type { ChangeDetector, ChangeEntry, FileSnapshot, SyncFilter, SyncableFS } from '../types';
import { buildSnapshot, diffSnapshots } from '../utils';

export class IncrementalDetector implements ChangeDetector {
  async detect(
    source: SyncableFS,
    _target: SyncableFS,
    root: string,
    prevSnapshots?: Map<string, FileSnapshot>,
    filter?: SyncFilter,
  ): Promise<ChangeEntry[]> {
    // 首次调用（无 prevSnapshots）回退到全量检测
    if (!prevSnapshots || prevSnapshots.size === 0) {
      const currentSnap = await buildSnapshot(source, root, filter);
      const targetSnap = await buildSnapshot(_target, root, filter);
      return diffSnapshots(currentSnap, targetSnap);
    }

    // 增量：只扫描源端，与上次源端快照对比
    const currentSourceSnap = await buildSnapshot(source, root, filter);
    return diffSnapshots(currentSourceSnap, prevSnapshots);
  }
}