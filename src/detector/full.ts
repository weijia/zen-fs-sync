/**
 * zen-fs-sync — 全量变更检测器
 *
 * 每次同步都重新扫描两端文件系统，构建完整快照再比较。
 * 适合文件数量较少或无状态记录的场景。
 */

import type {
  ChangeDetector,
  ChangeEntry,
  FileSnapshot,
  SyncFilter,
  SyncableFS,
} from '../types';
import { buildSnapshot, diffSnapshots } from '../utils';

export class FullDetector implements ChangeDetector {
  async detect(
    source: SyncableFS,
    target: SyncableFS,
    root: string,
    prevSnapshots?: Map<string, FileSnapshot>,
    filter?: SyncFilter,
  ): Promise<ChangeEntry[]> {
    const [sourceSnap, targetSnap] = await Promise.all([
      buildSnapshot(source, root, filter),
      buildSnapshot(target, root, filter),
    ]);
    return diffSnapshots(sourceSnap, targetSnap);
  }
}