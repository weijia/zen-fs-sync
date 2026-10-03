# SyncableFS 接口文档

## 概述

`SyncableFS` 是 zen-fs-sync 同步引擎的核心抽象接口。任何满足此接口的文件系统都可以作为同步的源端或目标端参与同步。

该接口仅要求异步 API，因此对 InMemory、IndexedDB、RemoteStorage、Gitee、GitHub 等任意 ZenFS 后端通用。ZenFS VFS 的 `fs.promises` 或 `@zenfs/core/promises` 导出天然满足此接口；Node.js 原生 `fs/promises` 也满足。

## 接口定义

```typescript
interface SyncableFS {
  // ── 必需方法 ──────────────────────────────────────────
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding?: BufferEncoding): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;

  // ── 可选方法 ──────────────────────────────────────────
  backendName?: string;
  writeFileWithMtime?(path: string, data: string | Uint8Array, mtimeMs: number): Promise<void>;
  onChange?(callback: () => void): void;
  shouldSync?(): Promise<boolean>;
  createSnapshot?(root: string, filter?: SyncFilter): Promise<Map<string, FileSnapshot> | null>;

  /** @deprecated 请使用 shouldSync() 替代 */
  checkForUpdates?(): Promise<boolean>;
}
```

---

## 后端实现契约（行为不变量）

> 本节规定**任何**实现 `SyncableFS` 的后端都必须满足的行为约束，是同步引擎、`zen-fs-cache`、`zen-fs-config` 正确工作的前提。方法级的逐条说明见后续章节。
>
> 这些约束是**条件性**的：只有当底层存储确实存在某项能力缺口、后端因而引入了内部实现文件时，才需要遵守对应的"隐藏 / 自建"要求。具备原生能力的文件系统（如 Node.js `fs/promises`、IndexedDB）不需要、也不应有这些内部文件。

### 1. 内部实现文件必须对调用者隐藏

部分后端为了弥补底层存储的能力缺口，会在内部创建"实现文件"，例如：

- 为了在无原生毫秒级 mtime 的存储上保留精确修改时间而写的 `.mtime` sidecar；
- 为了在**无法存储空目录**的存储上让目录存活而写的占位文件（如 `.keep`）。

这些文件**不是用户文件**，后端**必须**在以下操作中将其对调用者隐藏，绝不能泄漏到上层，也不能被同步引擎当作用户文件处理：

- `readdir`：返回的条目数组中过滤掉内部文件；
- `stat`：调用者不会去 stat 内部文件（因为 `readdir` 不暴露它），后端也不应把它以用户文件形态呈现；
- `createSnapshot`：快照中不得包含内部文件；
- `unlink` / `rmdir`：内部文件由后端自身在对应的写 / 删生命周期里维护，调用者无需也无法直接操作它。

> **并非所有文件系统都需要这些内部文件。** 本地文件系统（Node.js `fs/promises`、IndexedDB）具备原生 mtime、能原生存储空目录，因此既不需要 `.mtime` sidecar，也不需要目录占位文件。上述"隐藏"要求仅在后端**确实使用了**内部文件时才适用——没有内部文件的后端自然无需过滤。

### 2. 空目录的保留

部分底层存储（Git 类如 Gitee/GitHub、RemoteStorage）**无法表达空目录**：目录只是文件路径的前缀，一个没有任何文件的目录在该存储中根本没有载体，列举或同步时就会消失。

这类后端**必须**：

- 在 `mkdir` 中创建一个内部占位文件（典型命名 `.keep`）以保证目录存活；
- 在 `rmdir` 中清理该占位文件；
- 该占位文件按 §1 规则对调用者隐藏。

**同步引擎保留空目录的方式是：在目标端显式调用 `mkdir`，而不是把占位文件当作用户文件跨端同步。** 因此：

- 每个后端各自维护自己的占位文件（内容 / 命名可以不同，例如 Gitee 用 `\n`、RemoteStorage 用 `''`），互不干涉；
- 占位文件永远不会跨端传输内容或 mtime，也就不会产生无意义的冲突或 mtime 拉锯。

> 能原生存储空目录的后端（IndexedDB、本地 FS）无需占位文件，也不必在 `mkdir` / `rmdir` 中处理它。
>
> 后端**不应**假设占位文件会被当作用户文件同步——空目录的存活依赖同步引擎的 `mkdir`，而非占位文件的同步。（当前个别实现仍依赖占位文件被同步来保活空目录，属于待修复的偏差，不应作为契约依据。）

### 3. mtime 精度（可选能力）

部分后端没有原生毫秒级 mtime（如 Gitee/GitHub 的 commit 时间只有秒级精度，且不等于源文件修改时间）。这类后端应通过可选方法 `writeFileWithMtime` 把精确 mtime 持久化到内部 sidecar，并按 §1 规则隐藏（见该方法说明）。有原生 mtime 的后端无需实现该方法，也无需 sidecar。

---

## 必需方法

### `readdir(path: string): Promise<string[]>`

读取目录内容，返回目录条目名称数组。

- **参数**: `path` — 目录的绝对路径
- **返回**: 目录条目名称数组（不含路径前缀，仅文件名/子目录名）
- **异常**: 目录不存在或无权限时抛出异常
- **同步引擎用途**: 用于 `buildSnapshot()` 递归遍历文件树，以及 `ensureDir()` 检查目录是否存在
- **契约**: 返回结果中**不得包含后端内部实现文件**（如 `.mtime` sidecar、`.keep` 占位文件），见《后端实现契约》§1

```typescript
const entries = await fs.readdir('/app_data/configs');
// → ['config.json', 'subdir', '.meta']
```

### `readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>`

读取文件内容。支持两种调用形式：

- `readFile(path, 'utf-8')` → 返回 `string`
- `readFile(path)` → 返回 `Buffer`（或 `Uint8Array`）

- **同步引擎用途**: 同步时读取源文件内容以写入目标端；冲突检测时比较两端内容是否一致
- **注意**: 同步引擎始终使用 `'utf-8'` 编码读取，因为同步的文件均为文本配置文件

```typescript
const text = await fs.readFile('/config.json', 'utf-8');
const buffer = await fs.readFile('/config.json');
```

### `writeFile(path: string, data: string | Uint8Array): Promise<void>`

写入文件。如果父目录不存在，行为由具体后端决定（部分后端会自动创建）。

- **参数**: `path` — 文件绝对路径；`data` — 文件内容
- **同步引擎用途**: 将源端文件内容写入目标端
- **注意**: 同步引擎在调用 `writeFile` 前会先调用 `ensureDir()` 确保父目录存在

```typescript
await fs.writeFile('/config.json', '{"version": 1}');
```

### `unlink(path: string): Promise<void>`

删除文件。

- **参数**: `path` — 文件绝对路径
- **异常**: 文件不存在时抛出异常（同步引擎会 catch 并计为 skipped）
- **同步引擎用途**: 当源端文件被删除时，在目标端执行同样的删除

```typescript
await fs.unlink('/old-config.json');
```

### `stat(path: string): Promise<FileStat>`

获取文件/目录的元信息。

- **参数**: `path` — 路径
- **返回**: `FileStat` 对象
- **同步引擎用途**: 构建快照时获取每个文件的 `size` 和 `mtimeMs`，用于变更检测；`mode` 用于区分文件和目录

```typescript
const stat = await fs.stat('/config.json');
// → { mode: 0o100644, size: 42, mtimeMs: 1699766400000 }
```

### `mkdir(path: string, options?: { recursive?: boolean }): Promise<void>`

创建目录。

- **参数**: `path` — 目录路径；`options.recursive` — 是否递归创建父目录
- **同步引擎用途**: `ensureDir()` 在写入文件前递归创建目录；也是同步引擎**保留空目录**的手段（见《后端实现契约》§2）
- **契约**: 无法原生存储空目录的后端（如 Git 类、RemoteStorage）应在内部创建并隐藏占位文件（如 `.keep`）以保证目录存活，见《后端实现契约》§2

```typescript
await fs.mkdir('/app_data/configs/new-app', { recursive: true });
```

### `exists(path: string): Promise<boolean>`

检查路径是否存在。

- **参数**: `path` — 路径
- **返回**: `true` 存在，`false` 不存在
- **同步引擎用途**: `ensureDir()` 中逐级检查目录是否存在

```typescript
const exists = await fs.exists('/app_data/configs');
// → true
```

---

## 可选方法

### `backendName?: string`

后端的人类可读名称，仅用于日志输出。

- **示例**: `'RemoteStorage@storage.5apps.com/weijia'`、`'GitHub(my-repo)'`、`'local-idb'`
- **默认**: 未设置时日志显示 `'?'`

```typescript
const fs: SyncableFS = {
  backendName: 'MyBackend',
  // ...
};
```

### `writeFileWithMtime?(path, data, mtimeMs): Promise<void>`

写入文件并设置精确的修改时间。

- **参数**: `path` — 文件路径；`data` — 内容；`mtimeMs` — 修改时间（毫秒时间戳）
- **同步引擎用途**: `copyFile()` 时优先使用此方法保留源文件的真实 mtime，而非使用同步时间
- **何时实现**: 后端原生 mtime 不精确时（如 Gitee/GitHub 的 commit 时间只有秒级精度且不等于源文件修改时间）。实现方式通常是写入 `.mtime` sidecar 文件，**该 sidecar 必须按《后端实现契约》§1 对调用者隐藏**（在 `readdir` / `createSnapshot` 中过滤，调用者不会直接读写它）
- **回退**: 未实现时同步引擎使用普通 `writeFile()`，mtime 由后端自行决定（如 IndexedDB/InMemory 使用 `Date.now()`）。有原生 mtime 的后端无需实现此方法，也无需 sidecar

```typescript
// RemoteStorage 后端的实现示例
async writeFileWithMtime(path, data, mtimeMs) {
  await this.writeFile(path, data);
  await this.writeFile(path + '.mtime', String(mtimeMs));
}
```

### `onChange?(callback: () => void): void`

注册本地变更回调。当文件系统自身发生变更（writeFile/unlink）时，后端应调用此回调通知同步引擎。

- **参数**: `callback` — 变更通知回调（无参数）
- **同步引擎用途**: watch 模式下实现 push 式变更检测，同步引擎收到回调后做防抖处理再触发同步
- **何时实现**: 支持 push 的后端（如 IndexedDB、InMemory）应实现此方法
- **回退**: 不支持的后端不实现，同步引擎通过轮询 `shouldSync` 检测远端变更；两端都不支持时退化为传统定时轮询

```typescript
// InMemory 后端的实现示例
private changeCallbacks: (() => void)[] = [];

onChange(callback: () => void) {
  this.changeCallbacks.push(callback);
}

async writeFile(path, data) {
  // ... 写入逻辑 ...
  this.changeCallbacks.forEach(cb => cb());
}
```

### `shouldSync?(): Promise<boolean>`

检查远端是否有更新。由远程后端实现。

- **返回**: `true` 表示远端发生了外部变更，需要同步；`false` 表示无变更
- **同步引擎用途**: watch 模式下定时轮询此方法，检测远端外部变更
- **行为要求**:
  - 后端应在每次调用后更新内部基准状态
  - 首次调用（无基准）时，应初始化基准并返回 `true`（需要全量同步）
  - 调用失败时同步引擎会兜底触发同步
- **何时实现**: 远程后端（如 RemoteStorage、Gitee、GitHub）通过比较自身保存的基准状态与远端实际状态来检测外部变更
- **回退**: 未实现时视为无法检测远端变更

```typescript
// RemoteStorage 后端的实现示例
async shouldSync(): Promise<boolean> {
  // 比较 ETag 快照
  const currentSnapshot = await this.buildSnapshot();
  const changed = !this.snapshotsEqual(this.baseSnapshot, currentSnapshot);
  this.baseSnapshot = currentSnapshot;
  return changed;
}
```

### `createSnapshot?(root: string, filter?: SyncFilter): Promise<Map<string, FileSnapshot> | null>`

构建文件系统快照，返回所有文件的相对路径到元信息的映射。

- **参数**: `root` — 同步根路径；`filter` — 路径过滤器
- **返回**: `Map<string, FileSnapshot>` — 相对路径 → `{path, size, mtimeMs}`；`null` — 文件系统不可达
- **同步引擎用途**: `getSnapshot()` 优先调用此方法，用于增量变更检测和双向同步的快照对比
- **契约**: 快照中**不得包含后端内部实现文件**（如 `.mtime` sidecar、`.keep` 占位文件），见《后端实现契约》§1。空目录不需要、也不应以占位文件形式出现在快照中（空目录由 `mkdir` 保活，见 §2）
- **何时实现**: 能提供比通用 `walkFiles + stat` 更高效快照方法的后端应实现
  - Gitee/GitHub 后端可使用 Git tree API 一次性获取所有文件元信息
  - IndexedDB 后端可使用 `getAll()` 批量查询而非逐个 stat
  - InMemory 后端可直接遍历内部 Map
- **回退**: 未实现时同步引擎使用通用的 `buildSnapshot()`（`walkFiles + stat` 逐个遍历）

```typescript
// GitHub 后端的实现示例
async createSnapshot(root, filter) {
  // 使用 Git tree API 一次性获取所有文件
  const tree = await this.githubApi.getTree();
  const snapshot = new Map();
  for (const item of tree) {
    if (item.type === 'blob') {
      const relPath = '/' + item.path;
      if (!isPathAllowed(relPath, filter)) continue;
      snapshot.set(relPath, {
        path: relPath,
        size: item.size,
        mtimeMs: item.commitDate,
      });
    }
  }
  return snapshot;
}
```

### `checkForUpdates?(): Promise<boolean>` (已废弃)

`shouldSync()` 的旧名称。已废弃，请使用 `shouldSync()` 替代。

---

## FileStat 接口

文件元信息的最小接口。统一了 ZenFS 的 `InodeLike`（有 `mode`）和 Node.js 的 `Stats`（有 `isFile/isDirectory`）两种不同返回类型。

```typescript
interface FileStat {
  /** Unix mode（如 0o100644 = 文件, 0o040755 = 目录）。优先用 mode 判断类型 */
  mode?: number;
  size: number;
  mtimeMs: number;
}
```

### 辅助函数

```typescript
// 通过 mode 判断是否为目录
function isDirectory(stat: FileStat): boolean;
// → stat.mode & 0o40000 === 0o40000

// 通过 mode 判断是否为普通文件
function isFile(stat: FileStat): boolean;
// → stat.mode & 0o100000 === 0o100000
```

### 常见 mode 值

| 类型 | mode | 说明 |
|------|------|------|
| 普通文件 | `0o100644` | rw-r--r-- |
| 可执行文件 | `0o100755` | rwxr-xr-x |
| 目录 | `0o040755` | rwxr-xr-x |

---

## 同步引擎如何调用 SyncableFS

### 单次同步流程 (`sync()`)

```
1. preSyncHook()（如果配置了）
2. 构建快照
   ├─ 优先调用 fs.createSnapshot(root, filter)
   └─ 回退到 buildSnapshot(fs, root, filter)
      ├─ fs.readdir(root)
      ├─ 对每个条目: fs.stat(fullPath) → 判断文件/目录
      ├─ 递归进入子目录
      └─ 对每个文件: fs.stat(fullPath) → {size, mtimeMs}
3. 变更检测 (IncrementalDetector)
   ├─ 首次: 全量对比 source 和 target 快照
   └─ 增量: 只扫描 source，与上次 source 快照对比
4. 执行变更
   ├─ Created/Modified:
   │   ├─ src.readFile(path, 'utf-8')
   │   ├─ tgt.readFile(path, 'utf-8') → 内容相同则跳过
   │   ├─ ensureDir(tgt, parentDir) → tgt.exists() + tgt.mkdir()
   │   └─ tgt.writeFileWithMtime(path, content, mtime) 或 tgt.writeFile(path, content)
   └─ Deleted:
       └─ tgt.unlink(path)
5. postSyncHook()（如果配置了）
```

### 双向同步流程 (`syncBidirectional()`)

```
1. 并行构建两端快照: source.createSnapshot() + target.createSnapshot()
2. 对比快照:
   ├─ 两端都没有变 → 跳过
   ├─ 仅 source 变了 → source → target 单向同步
   ├─ 仅 target 变了 → target → source 单向同步
   └─ 两端都变了 → 冲突解决
3. 冲突处理:
   ├─ mtime 相同但 size 不同 → 内容不同 → 冲突解决器
   ├─ mtime 不同但内容相同 → 归一化 mtime 到较早值
   └─ mtime 不同且内容不同 → 较新的一端覆盖较旧的一端
```

### Watch 模式 (`watch()`)

```
1. 构建初始快照 (buildInitialSnapshots)
2. 注册 onChange 回调（如果后端支持）
   └─ 收到回调 → 防抖 (debounceMs) → sync()
3. 定时轮询 shouldSync（如果后端支持）
   └─ 任一端返回 true → sync()
4. 兜底: 两端都不支持 onChange 和 shouldSync → 传统轮询
```

---

## 实现指南

### 最小实现

只需实现 8 个必需方法即可参与同步：

```typescript
import type { SyncableFS, FileStat } from 'zen-fs-sync';

const myFS: SyncableFS = {
  backendName: 'MyBackend',

  async readdir(path) { /* ... */ },
  async readFile(path, encoding) { /* ... */ },
  async writeFile(path, data) { /* ... */ },
  async unlink(path) { /* ... */ },
  async stat(path) { /* ... */ },
  async mkdir(path, options) { /* ... */ },
  async exists(path) { /* ... */ },
};
```

### 完整实现（带优化）

实现可选方法可以显著提升同步性能：

```typescript
const optimizedFS: SyncableFS = {
  backendName: 'OptimizedBackend',

  // ── 必需方法 ──
  async readdir(path) { /* ... */ },
  async readFile(path, encoding) { /* ... */ },
  async writeFile(path, data) { /* ... */ },
  async unlink(path) { /* ... */ },
  async stat(path) { /* ... */ },
  async mkdir(path, options) { /* ... */ },
  async exists(path) { /* ... */ },

  // ── 可选优化 ──

  // 保留精确 mtime（避免 sidecar 文件被同步）
  async writeFileWithMtime(path, data, mtimeMs) {
    await this.writeFile(path, data);
    // 存储到内部 Map，不创建 sidecar 文件
    this.mtimeCache.set(path, mtimeMs);
  },

  // push 式变更通知（避免轮询）
  onChange(callback) {
    this.changeCallbacks.push(callback);
  },

  // 远端变更检测（避免全量扫描）
  async shouldSync() {
    const remoteEtag = await this.headRequest('/');
    if (remoteEtag !== this.lastEtag) {
      this.lastEtag = remoteEtag;
      return true;
    }
    return false;
  },

  // 批量快照（避免逐个 stat）
  async createSnapshot(root, filter) {
    // 使用后端特有 API 一次性获取所有文件元信息
    const items = await this.listAllFiles(root);
    const snapshot = new Map();
    for (const item of items) {
      snapshot.set(item.path, {
        path: item.path,
        size: item.size,
        mtimeMs: item.mtime,
      });
    }
    return snapshot;
  },
};
```

### 使用适配器

如果你的文件系统已经接近 `SyncableFS` 接口，可以使用 `zen-fs-config` 提供的适配器：

```typescript
import { backendToSyncableFS, zenfsPromisesToSyncableFS } from 'zen-fs-config';

// 从 BackendInstance 适配
const syncable1 = backendToSyncableFS(backendInstance, 'my-backend');

// 从 ZenFS promises 适配
const syncable2 = zenfsPromisesToSyncableFS(fs.promises);

// 从 CachedFileSystem 适配
const syncable3 = cachedFSToSyncableFS(cachedFS, 'cached-backend');
```

---

## 已知实现

| 后端 | 必需方法 | writeFileWithMtime | onChange | shouldSync | createSnapshot |
|------|----------|-------------------|----------|------------|----------------|
| InMemory | ✓ | ✓ | ✓ | — | ✓ |
| IndexedDB (zen-fs-dom) | ✓ | ✓ | ✓ | — | — |
| RemoteStorage | ✓ | ✓ (.mtime sidecar) | — | ✓ (ETag) | — |
| Gitee | ✓ | ✓ (.mtime sidecar) | — | ✓ (commit SHA) | ✓ (Git tree API) |
| GitHub | ✓ | ✓ (.mtime sidecar) | — | ✓ (commit SHA) | ✓ (Git tree API) |
| Node.js fs/promises | ✓ | — | — | — | — |

### 说明

- **InMemory / IndexedDB**: 本地后端，支持 `onChange` push 式通知，无需 `shouldSync`
- **RemoteStorage**: 远程后端，通过 ETag 检测远端变更，使用 `.mtime` sidecar 文件保存精确 mtime
- **Gitee / GitHub**: 远程后端，通过 commit SHA 检测变更，使用 Git tree API 批量获取文件列表
- **Node.js fs/promises**: 天然满足必需方法，但无可选方法

---

## 类型导出

```typescript
// 从 zen-fs-sync 导入
import type {
  SyncableFS,
  FileStat,
  FileSnapshot,
  SyncFilter,
  ChangeEntry,
  ChangeDetector,
  ConflictResolver,
  ConflictEntry,
  SyncOptions,
  SyncResult,
  SyncPairStatus,
  SyncEvent,
} from 'zen-fs-sync';

import {
  ChangeType,        // enum: Created, Modified, Deleted
  ConflictStrategy,  // enum: SourceWins, TargetWins, Merge
  SyncDirection,     // enum: OneWay, BiDirectional
  SyncPairState,     // enum: Idle, Syncing, Watching, Paused, Disposed
  isDirectory,       // (stat: FileStat) => boolean
  isFile,            // (stat: FileStat) => boolean
} from 'zen-fs-sync';
```

---

## 调试

同步引擎使用 `@richard432/localstorage-logger` 进行日志输出。每个模块有独立的 localStorage 开关：

| 模块 | localStorage key | 说明 |
|------|-----------------|------|
| 同步核心 | `debug:zen-fs-sync:sync` | SyncPair 生命周期、同步流程 |
| 变更检测 | `debug:zen-fs-sync:detector` | 快照构建、变更检测 |
| 冲突解决 | `debug:zen-fs-sync:strategy` | 冲突解决器 |

```javascript
// 浏览器控制台
localStorage.setItem('debug:zen-fs-sync:sync', '1');      // 开启同步日志
localStorage.setItem('debug:zen-fs-sync:detector', '0');   // 关闭检测日志
localStorage.setItem('debug:zen-fs-sync:sync', '0');       // 关闭同步日志
```

也可通过 API 控制：

```typescript
import { setDebug } from 'zen-fs-sync';

setDebug(true);              // 开启所有模块
setDebug(false);             // 关闭所有模块
setDebug('sync,detector');   // 仅开启指定模块
```
