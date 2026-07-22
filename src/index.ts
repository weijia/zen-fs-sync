/**
 * zen-fs-sync
 *
 * ZenFS 虚拟文件系统之间的同步引擎。
 * 支持单向/双向同步、全量/增量检测、冲突解决、watch 模式。
 */

// 核心类
export { ZenFSSync } from './zen-fs-sync';
export { SyncPair } from './sync-pair';

// Debug logger
export { setDebug, isDebugEnabled, createLogger } from './logger';

// 检测器
export { FullDetector } from './detector/full';
export { IncrementalDetector } from './detector/incremental';

// 冲突解决
export { DefaultConflictResolver } from './strategy/default';

// 所有类型
export type {
  SyncableFS,
  FileStat,
  FileSnapshot,
  ChangeDetector,
  ConflictResolver,
  ConflictEntry,
  SyncFilter,
  SyncOptions,
  ResolvedSyncOptions,
  SyncResult,
  SyncPairStatus,
  SyncEvent,
  SyncEventHandler,
  ChangeEntry,
} from './types';

export {
  ChangeType,
  ConflictStrategy,
  SyncDirection,
  SyncPairState,
  SyncEventType,
  isDirectory,
  isFile,
} from './types';