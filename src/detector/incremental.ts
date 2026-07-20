/**
 * zen-fs-sync — 增量变更检测器
 *
 * 利用上次同步后的快照记录（sourceSnapshotMap），
 * 只对比当前源端快照与上次源端快照的差异，避免每次扫描目标端。
 * 适用于 watch 模式下高频同步。
 */

import type { ChangeDetector, ChangeEntry, FileSnapshot, SyncFilter, SyncableFS } from '../types';
import { buildSnapshot, diffSnapshots } from '../utils';
import { createLogger } from '../logger';

const log = createLogger('detector');

export class IncrementalDetector implements ChangeDetector {
  async detect(
    source: SyncableFS,
    target: SyncableFS,
    root: string,
    prevSnapshots?: Map<string, FileSnapshot>,
    filter?: SyncFilter,
  ): Promise<ChangeEntry[]> {
    // 首次调用（无 prevSnapshots）回退到全量检测
    if (!prevSnapshots || prevSnapshots.size === 0) {
      log(`[FULL] no prevSnapshots, scanning source + target (root=${root})`);
      const currentSnap = await buildSnapshot(source, root, filter);
      const targetSnap = await buildSnapshot(target, root, filter);
      log(`[FULL] source files: ${currentSnap.size}, target files: ${targetSnap.size}`);
      const changes = diffSnapshots(currentSnap, targetSnap);
      log(`[FULL] detected ${changes.length} changes:`, changes.map(c => `${c.type}:${c.path}`));
      return changes;
    }

    // 增量：只扫描源端，与上次源端快照对比
    log(`[INCREMENTAL] scanning source vs prevSnapshots (${prevSnapshots.size} entries, root=${root})`);
    const currentSourceSnap = await buildSnapshot(source, root, filter);
    log(`[INCREMENTAL] current source files: ${currentSourceSnap.size}`);
    const changes = diffSnapshots(currentSourceSnap, prevSnapshots);
    log(`[INCREMENTAL] detected ${changes.length} changes:`, changes.map(c => `${c.type}:${c.path}`));
    return changes;
  }
}
