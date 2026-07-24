/**
 * zen-fs-sync — 核心类型定义
 *
 * 所有公共类型集中在此文件，作为库的 API 契约。
 */

// ---------------------------------------------------------------------------
// 可同步的文件系统抽象
// ---------------------------------------------------------------------------

/**
 * 文件元信息的最小接口。
 * ZenFS 的 stat 返回 InodeLike（有 mode），Node.js 的 stat 返回 Stats（有 isFile/isDirectory），
 * 这里统一用 mode 判断类型，不再要求 isFile/isDirectory 方法。
 */
export interface FileStat {
  /** Unix mode（e.g. 0o100644 = 文件, 0o040755 = 目录）。优先用 mode 判断类型 */
  mode?: number;
  size: number;
  mtimeMs: number;
}

/** 通过 mode 判断是否为目录 */
export function isDirectory(stat: FileStat): boolean {
  return stat.mode !== undefined && (stat.mode & 0o40000) === 0o40000;
}

/** 通过 mode 判断是否为普通文件 */
export function isFile(stat: FileStat): boolean {
  return stat.mode !== undefined && (stat.mode & 0o100000) === 0o100000;
}

/**
 * 可同步文件系统的最小接口。
 *
 * 只要求异步 API，因此对 InMemory / IndexedDB / S3 等任意 ZenFS 后端通用。
 * ZenFS VFS 的 `fs.promises` 或 `@zenfs/core/promises` 导出天然满足此接口；
 * Node.js 原生 `fs/promises` 也满足。
 */
export interface SyncableFS {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Optional: human-readable backend name for logging (e.g. 'RemoteStorage@5apps') */
  backendName?: string;
}

// ---------------------------------------------------------------------------
// 文件快照与变更检测
// ---------------------------------------------------------------------------

/** 某个文件在某一时刻的状态快照 */
export interface FileSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
}

/** 变更类型 */
export enum ChangeType {
  Created = 'created',
  Modified = 'modified',
  Deleted = 'deleted',
}

/** 单个文件的变更条目 */
export interface ChangeEntry {
  /** 相对于同步根目录的路径 */
  path: string;
  type: ChangeType;
  /** 源端快照（Created/Modified 时存在） */
  sourceSnapshot?: FileSnapshot;
  /** 目标端快照（Modified/Deleted 时存在） */
  targetSnapshot?: FileSnapshot;
}

// ---------------------------------------------------------------------------
// 变更检测器
// ---------------------------------------------------------------------------

/**
 * 变更检测策略接口。
 *
 * 负责比较两个快照集（或做全量扫描），产出 ChangeEntry[]。
 */
export interface ChangeDetector {
  /**
   * 检测 source 与 target 之间的差异。
   * @param source         源文件系统
   * @param target         目标文件系统
   * @param root           同步根路径
   * @param prevSnapshots  上次同步后的快照记录（增量模式使用）
   * @param filter         路径过滤器
   */
  detect(
    source: SyncableFS,
    target: SyncableFS,
    root: string,
    prevSnapshots?: Map<string, FileSnapshot>,
    filter?: SyncFilter,
  ): Promise<ChangeEntry[]>;
}

// ---------------------------------------------------------------------------
// 冲突解决
// ---------------------------------------------------------------------------

/** 冲突解决策略 */
export enum ConflictStrategy {
  /** 源端覆盖目标端 */
  SourceWins = 'source-wins',
  /** 目标端覆盖源端（双向同步时保留目标） */
  TargetWins = 'target-wins',
  /** JSON 深合并（仅对 .json 文件生效，其余回退到 SourceWins） */
  Merge = 'merge',
}

/** 单个冲突条目 */
export interface ConflictEntry {
  /** 冲突文件路径 */
  path: string;
  /** 源端内容 */
  sourceContent: string;
  /** 目标端内容 */
  targetContent: string;
  /** 最终采用的策略 */
  resolvedWith: ConflictStrategy;
  /** 合并后的内容（仅 Merge 策略时有值） */
  mergedContent?: string;
}

/**
 * 冲突解决器接口。
 *
 * 当双向同步中同一文件在两端都被修改时调用。
 */
export interface ConflictResolver {
  resolve(
    path: string,
    sourceContent: string,
    targetContent: string,
    strategy: ConflictStrategy,
  ): Promise<{ content: string; strategy: ConflictStrategy }>;
}

// ---------------------------------------------------------------------------
// 同步配置
// ---------------------------------------------------------------------------

/** 同步方向 */
export enum SyncDirection {
  /** 仅 source → target */
  OneWay = 'one-way',
  /** source ↔ target（双向） */
  BiDirectional = 'bi-directional',
}

/** 路径过滤规则 */
export interface SyncFilter {
  /** 只同步这些路径前缀（空数组 = 不过滤） */
  includePrefixes?: string[];
  /** 排除这些路径前缀 */
  excludePrefixes?: string[];
  /** glob 模式匹配（仅匹配文件名） */
  includeGlobs?: string[];
}

/** 同步对配置 */
export interface SyncOptions {
  /** 同步方向，默认 OneWay */
  direction?: SyncDirection;
  /** 冲突解决策略，默认 SourceWins */
  conflictStrategy?: ConflictStrategy;
  /** 路径过滤器 */
  filter?: SyncFilter;
  /** watch 模式下的防抖间隔（ms），默认 300 */
  debounceMs?: number;
}

/** 同步对的内部配置（所有字段已填充默认值） */
export interface ResolvedSyncOptions {
  direction: SyncDirection;
  conflictStrategy: ConflictStrategy;
  filter?: SyncFilter;
  debounceMs: number;
}

// ---------------------------------------------------------------------------
// 同步结果
// ---------------------------------------------------------------------------

/** 单次同步操作的结果 */
export interface SyncResult {
  pairId: string;
  direction: SyncDirection;
  timestamp: number;
  /** 新创建的文件数 */
  filesCreated: number;
  /** 更新的文件数 */
  filesUpdated: number;
  /** 删除的文件数 */
  filesDeleted: number;
  /** 跳过的文件数（被 filter 排除） */
  filesSkipped: number;
  /** 冲突列表 */
  conflicts: ConflictEntry[];
  /** 变更明细 */
  changes: ChangeEntry[];
  /** 耗时（ms） */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 同步对状态
// ---------------------------------------------------------------------------

/** 同步对的运行时状态 */
export enum SyncPairState {
  /** 空闲 */
  Idle = 'idle',
  /** 正在同步 */
  Syncing = 'syncing',
  /** watch 监听中 */
  Watching = 'watching',
  /** 已暂停 */
  Paused = 'paused',
  /** 已销毁 */
  Disposed = 'disposed',
}

/** 同步对状态快照 */
export interface SyncPairStatus {
  pairId: string;
  /** Source backend name (e.g. 'local-idb') */
  sourceName?: string;
  /** Target backend name (e.g. 'GitHub(my-repo)') */
  targetName?: string;
  state: SyncPairState;
  /** 最近一次同步结果 */
  lastResult?: SyncResult;
  /** 最近一次检查同步的时间（即使无变更） */
  lastCheckTime?: number;
  /** 是否正在 watch */
  watching: boolean;
  /** 同步次数累计 */
  totalSyncs: number;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export type SyncEventType = 'sync:start' | 'sync:end' | 'sync:error' | 'conflict' | 'watch:start' | 'watch:stop';

export interface SyncEvent {
  type: SyncEventType;
  pairId: string;
  /** sync:end 时附带结果 */
  result?: SyncResult;
  /** sync:error 时附带错误 */
  error?: Error;
  /** conflict 时附带冲突条目 */
  conflict?: ConflictEntry;
  timestamp: number;
}

export type SyncEventHandler = (event: SyncEvent) => void;