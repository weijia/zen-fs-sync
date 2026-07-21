/**
 * zen-fs-sync — 核心类型定义
 *
 * 所有公共类型集中在此文件，作为库的 API 契约。
 */
/**
 * 文件元信息的最小接口。
 * ZenFS 的 stat 返回 InodeLike，Node.js 的 stat 返回 Stats，
 * 这里取两者交集，保持通用。
 */
interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
}
/**
 * 可同步文件系统的最小接口。
 *
 * 只要求异步 API，因此对 InMemory / IndexedDB / S3 等任意 ZenFS 后端通用。
 * ZenFS VFS 的 `fs.promises` 或 `@zenfs/core/promises` 导出天然满足此接口；
 * Node.js 原生 `fs/promises` 也满足。
 */
interface SyncableFS {
    readdir(path: string): Promise<string[]>;
    readFile(path: string, encoding?: BufferEncoding): Promise<string>;
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<FileStat>;
    mkdir(path: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
    exists(path: string): Promise<boolean>;
}
/** 某个文件在某一时刻的状态快照 */
interface FileSnapshot {
    path: string;
    size: number;
    mtimeMs: number;
}
/** 变更类型 */
declare enum ChangeType {
    Created = "created",
    Modified = "modified",
    Deleted = "deleted"
}
/** 单个文件的变更条目 */
interface ChangeEntry {
    /** 相对于同步根目录的路径 */
    path: string;
    type: ChangeType;
    /** 源端快照（Created/Modified 时存在） */
    sourceSnapshot?: FileSnapshot;
    /** 目标端快照（Modified/Deleted 时存在） */
    targetSnapshot?: FileSnapshot;
}
/**
 * 变更检测策略接口。
 *
 * 负责比较两个快照集（或做全量扫描），产出 ChangeEntry[]。
 */
interface ChangeDetector {
    /**
     * 检测 source 与 target 之间的差异。
     * @param source         源文件系统
     * @param target         目标文件系统
     * @param root           同步根路径
     * @param prevSnapshots  上次同步后的快照记录（增量模式使用）
     * @param filter         路径过滤器
     */
    detect(source: SyncableFS, target: SyncableFS, root: string, prevSnapshots?: Map<string, FileSnapshot>, filter?: SyncFilter): Promise<ChangeEntry[]>;
}
/** 冲突解决策略 */
declare enum ConflictStrategy {
    /** 源端覆盖目标端 */
    SourceWins = "source-wins",
    /** 目标端覆盖源端（双向同步时保留目标） */
    TargetWins = "target-wins",
    /** JSON 深合并（仅对 .json 文件生效，其余回退到 SourceWins） */
    Merge = "merge"
}
/** 单个冲突条目 */
interface ConflictEntry {
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
interface ConflictResolver {
    resolve(path: string, sourceContent: string, targetContent: string, strategy: ConflictStrategy): Promise<{
        content: string;
        strategy: ConflictStrategy;
    }>;
}
/** 同步方向 */
declare enum SyncDirection {
    /** 仅 source → target */
    OneWay = "one-way",
    /** source ↔ target（双向） */
    BiDirectional = "bi-directional"
}
/** 路径过滤规则 */
interface SyncFilter {
    /** 只同步这些路径前缀（空数组 = 不过滤） */
    includePrefixes?: string[];
    /** 排除这些路径前缀 */
    excludePrefixes?: string[];
    /** glob 模式匹配（仅匹配文件名） */
    includeGlobs?: string[];
}
/** 同步对配置 */
interface SyncOptions {
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
interface ResolvedSyncOptions {
    direction: SyncDirection;
    conflictStrategy: ConflictStrategy;
    filter?: SyncFilter;
    debounceMs: number;
}
/** 单次同步操作的结果 */
interface SyncResult {
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
/** 同步对的运行时状态 */
declare enum SyncPairState {
    /** 空闲 */
    Idle = "idle",
    /** 正在同步 */
    Syncing = "syncing",
    /** watch 监听中 */
    Watching = "watching",
    /** 已暂停 */
    Paused = "paused",
    /** 已销毁 */
    Disposed = "disposed"
}
/** 同步对状态快照 */
interface SyncPairStatus {
    pairId: string;
    state: SyncPairState;
    /** 最近一次同步结果 */
    lastResult?: SyncResult;
    /** 是否正在 watch */
    watching: boolean;
    /** 同步次数累计 */
    totalSyncs: number;
}
type SyncEventType = 'sync:start' | 'sync:end' | 'sync:error' | 'conflict' | 'watch:start' | 'watch:stop';
interface SyncEvent {
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
type SyncEventHandler = (event: SyncEvent) => void;

/**
 * zen-fs-sync — SyncPair 核心类
 *
 * 管理一对文件系统之间的同步逻辑，包括：
 * - 单次手动同步
 * - watch 模式（轮询 + 防抖）
 * - 事件通知
 * - 快照持久化（用于增量检测）
 */

declare class SyncPair {
    private readonly syncRoot;
    readonly pairId: string;
    readonly source: SyncableFS;
    readonly target: SyncableFS;
    readonly root: string;
    private readonly options;
    private readonly detector;
    private readonly resolver;
    private state;
    private lastResult?;
    private totalSyncs;
    private watchers?;
    private debounceTimer?;
    private listeners;
    private sourceSnapshots?;
    constructor(source: SyncableFS, target: SyncableFS, options?: SyncOptions, syncRoot?: string);
    /**
     * 执行一次同步。
     */
    sync(): Promise<SyncResult>;
    /**
     * 启动自动监听同步。
     * 使用轮询检测变更，防抖触发同步。
     */
    watch(): void;
    /**
     * 停止自动监听。
     */
    unwatch(): void;
    getStatus(): SyncPairStatus;
    /**
     * 销毁同步对，停止 watch 并释放资源。
     */
    dispose(): void;
    on(event: SyncEventType, handler: SyncEventHandler): void;
    off(event: SyncEventType, handler: SyncEventHandler): void;
    private emit;
    private syncOneWay;
    private syncBidirectional;
    private copyFile;
    private writeFileBoth;
    private onPoll;
    private buildInitialSnapshots;
}

/**
 * zen-fs-sync — ZenFSSync 管理器
 *
 * 顶层入口，管理多个 SyncPair 的生命周期。
 * 提供创建、查询、批量操作的便捷方法。
 */

declare class ZenFSSync {
    private pairs;
    /**
     * 创建一个同步对并注册到管理器。
     *
     * @param source  源文件系统（满足 SyncableFS 接口）
     * @param target  目标文件系统
     * @param options 同步选项
     * @param root    同步根路径，默认 '/'
     * @returns SyncPair 实例
     */
    addPair(source: SyncableFS, target: SyncableFS, options?: SyncOptions, root?: string): SyncPair;
    /**
     * 手动触发指定同步对的一次同步。
     */
    sync(pairId: string): Promise<SyncResult>;
    /**
     * 同步所有已注册的对。
     * 并行执行，返回所有结果。
     */
    syncAll(): Promise<Map<string, SyncResult>>;
    /**
     * 启动指定同步对的自动监听。
     */
    watch(pairId: string): void;
    /**
     * 停止指定同步对的自动监听。
     */
    unwatch(pairId: string): void;
    /**
     * 启动所有同步对的自动监听。
     */
    watchAll(): void;
    /**
     * 停止所有同步对的自动监听。
     */
    unwatchAll(): void;
    /**
     * 获取指定同步对的状态。
     */
    getStatus(pairId: string): SyncPairStatus;
    /**
     * 获取所有同步对的状态。
     */
    getStatusAll(): Map<string, SyncPairStatus>;
    /**
     * 列出所有已注册的 pairId。
     */
    listPairs(): string[];
    /**
     * 为指定同步对注册事件监听。
     */
    on(pairId: string, event: string, handler: SyncEventHandler): void;
    /**
     * 移除指定同步对的事件监听。
     */
    off(pairId: string, event: string, handler: SyncEventHandler): void;
    /**
     * 移除并销毁指定同步对。
     */
    removePair(pairId: string): void;
    /**
     * 销毁管理器及所有同步对。
     */
    dispose(): void;
    private getPair;
}

/**
 * zen-fs-sync — Debug Logger
 *
 * 轻量级调试日志系统，支持全局开关和标签过滤。
 *
 * 使用方式：
 *   import { createLogger } from './logger';
 *   const log = createLogger('sync');
 *   log('file list:', files);           // [zen-fs-sync:sync] file list: [...]
 *
 * 开启调试（在调用 createConfigRepo 之前设置）：
 *   import { setDebug } from 'zen-fs-sync/logger';
 *   setDebug(true);                        // 开启全部
 *   setDebug('sync,detector');             // 只开 sync 和 detector 标签
 */
declare function setDebug(value: boolean | string): void;
declare function isDebugEnabled(): boolean;
declare function createLogger(tag: string): (...args: unknown[]) => void;

/**
 * zen-fs-sync — 全量变更检测器
 *
 * 每次同步都重新扫描两端文件系统，构建完整快照再比较。
 * 适合文件数量较少或无状态记录的场景。
 */

declare class FullDetector implements ChangeDetector {
    detect(source: SyncableFS, target: SyncableFS, root: string, prevSnapshots?: Map<string, FileSnapshot>, filter?: SyncFilter): Promise<ChangeEntry[]>;
}

/**
 * zen-fs-sync — 增量变更检测器
 *
 * 利用上次同步后的快照记录（sourceSnapshotMap），
 * 只对比当前源端快照与上次源端快照的差异，避免每次扫描目标端。
 * 适用于 watch 模式下高频同步。
 */

declare class IncrementalDetector implements ChangeDetector {
    detect(source: SyncableFS, target: SyncableFS, root: string, prevSnapshots?: Map<string, FileSnapshot>, filter?: SyncFilter): Promise<ChangeEntry[]>;
}

/**
 * zen-fs-sync — 默认冲突解决器
 *
 * 支持 source-wins / target-wins / merge 三种策略。
 * merge 仅对 JSON 文件执行深合并，其余类型回退到 source-wins。
 */

declare class DefaultConflictResolver implements ConflictResolver {
    resolve(path: string, sourceContent: string, targetContent: string, strategy: ConflictStrategy): Promise<{
        content: string;
        strategy: ConflictStrategy;
    }>;
}

export { type ChangeDetector, type ChangeEntry, ChangeType, type ConflictEntry, type ConflictResolver, ConflictStrategy, DefaultConflictResolver, type FileSnapshot, type FileStat, FullDetector, IncrementalDetector, type ResolvedSyncOptions, SyncDirection, type SyncEvent, type SyncEventHandler, type SyncEventType, type SyncFilter, type SyncOptions, SyncPair, SyncPairState, type SyncPairStatus, type SyncResult, type SyncableFS, ZenFSSync, createLogger, isDebugEnabled, setDebug };
