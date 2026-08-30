# zen-fs-sync

Synchronization engine for [ZenFS](https://github.com/weijia/zen-fs) virtual file system instances. Sync files between any two backends — IndexedDB, InMemory, Gitee, GitHub, RemoteStorage, WebDAV, and more — with one-way or two-way direction, incremental change detection, and conflict resolution.

## Features

- **One-way or two-way sync** — choose a direction that fits your use case
- **Incremental detection** — only sync files that changed since the last run
- **Conflict resolution** — source-wins, target-wins, or JSON deep-merge strategies
- **Watch mode** — real-time sync via local change events, with polling for remote backends
- **Path filtering** — include/exclude prefixes or filename glob patterns
- **Backend-agnostic** — works with any backend implementing the `SyncableFS` interface
- **Pre/post sync hooks** — run custom logic before and after each sync cycle
- **Event system** — subscribe to sync start, end, error, and conflict events

## Installation

```bash
npm install zen-fs-sync @zenfs/core
```

## Quick Start

### One-way sync between two file systems

```typescript
import { SyncPair, SyncDirection } from 'zen-fs-sync';

// Assume `localFS` and `remoteFS` implement the SyncableFS interface
const pair = new SyncPair(localFS, remoteFS, {
  direction: SyncDirection.OneWay,
});

const result = await pair.sync();
console.log(`Synced ${result.filesCreated + result.filesUpdated} files`);
```

### Two-way sync with conflict resolution

```typescript
import { SyncPair, SyncDirection, ConflictStrategy } from 'zen-fs-sync';

const pair = new SyncPair(localFS, remoteFS, {
  direction: SyncDirection.BiDirectional,
  conflictStrategy: ConflictStrategy.Merge, // JSON deep-merge
});

const result = await pair.sync();
if (result.conflicts.length > 0) {
  console.log(`Resolved ${result.conflicts.length} conflicts`);
}
```

### Watch mode (continuous sync)

```typescript
import { SyncPair, SyncDirection } from 'zen-fs-sync';

const pair = new SyncPair(localFS, remoteFS, {
  direction: SyncDirection.BiDirectional,
  debounceMs: 300,        // debounce local changes
  pollIntervalMs: 1800000, // poll remote every 30 min
});

pair.on('sync:end', (event) => {
  console.log('Sync completed:', event.result);
});

pair.watch();

// Later:
// pair.unwatch();
```

### Path filtering

```typescript
const pair = new SyncPair(sourceFS, targetFS, {
  filter: {
    includePrefixes: ['/config/', '/data/'],
    excludePrefixes: ['/temp/'],
    includeGlobs: ['*.json', '*.yaml'],
  },
});
```

## API

### SyncPair

The core class that manages synchronization between two file systems.

#### Constructor

```typescript
new SyncPair(source, target, options?, root?)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `source` | `SyncableFS` | Source file system |
| `target` | `SyncableFS` | Target file system |
| `options` | `SyncOptions` | Sync configuration (optional) |
| `root` | `string` | Root path to sync, defaults to `'/'` |

#### Methods

| Method | Description |
|--------|-------------|
| `sync()` | Run a single sync cycle. Returns `SyncResult` |
| `watch()` | Start continuous sync (local events + remote polling) |
| `unwatch()` | Stop continuous sync |
| `pause()` | Pause syncing (watch stays active but skips syncs) |
| `resume()` | Resume from paused state |
| `getStatus()` | Get current status snapshot (`SyncPairStatus`) |
| `on(event, handler)` | Subscribe to sync events |
| `off(event, handler)` | Unsubscribe from sync events |
| `dispose()` | Stop watching and release resources |

#### SyncOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `direction` | `SyncDirection` | `OneWay` | Sync direction: `OneWay` or `BiDirectional` |
| `conflictStrategy` | `ConflictStrategy` | `SourceWins` | How to resolve conflicts: `SourceWins`, `TargetWins`, or `Merge` |
| `filter` | `SyncFilter` | — | Path filtering rules |
| `debounceMs` | `number` | `300` | Debounce interval for local change events (ms) |
| `pollIntervalMs` | `number` | `1800000` | Polling interval for remote backends (ms, default 30 min) |
| `preSyncHook` | `() => Promise<void>` | — | Hook run before each sync cycle |
| `postSyncHook` | `() => Promise<void>` | — | Hook run after each sync cycle |

### SyncableFS Interface

Any file system that implements this interface can be synced. ZenFS backends (`fs.promises`) and Node.js `fs/promises` both satisfy it out of the box.

```typescript
interface SyncableFS {
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<Uint8Array>;
  readFile(path: string, encoding: string): Promise<string>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  backendName?: string;

  // Optional optimizations:
  writeFileWithMtime?(path, data, mtimeMs): Promise<void>;
  onChange?(callback: () => void): void;
  shouldSync?(): Promise<boolean>;
  createSnapshot?(root, filter?): Promise<Map<string, FileSnapshot> | null>;
}
```

| Optional method | Purpose |
|-----------------|---------|
| `writeFileWithMtime` | Preserve source file's mtime when writing to target |
| `onChange` | Push-based change detection (local backends) |
| `shouldSync` | Pull-based change detection (remote backends) |
| `createSnapshot` | Efficient snapshot building (faster than walk + stat) |

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `sync:start` | `{ pairId, timestamp }` | Sync cycle started |
| `sync:end` | `{ pairId, result }` | Sync cycle completed |
| `sync:error` | `{ pairId, error }` | Sync cycle failed |
| `conflict` | `{ pairId, conflict }` | A conflict was detected and resolved |
| `watch:start` | `{ pairId }` | Watch mode started |
| `watch:stop` | `{ pairId }` | Watch mode stopped |

### ZenFSSync

A manager class for multiple sync pairs. Useful when you need to sync a local backend with several remote backends.

```typescript
import { ZenFSSync } from 'zen-fs-sync';

const sync = new ZenFSSync();

const pairId = sync.addPair(localFS, remoteFS, { direction: SyncDirection.BiDirectional });
sync.watch(pairId);

// Get all pairs
const statuses = sync.getAllStatuses();
```

## Architecture

```
Source FS ←→ Change Detector ←→ Conflict Resolver ←→ Target FS
              (incremental)         (JSON merge)
                    ↑                     ↑
              Snapshots              Strategies
              (persisted)         (source-wins, etc.)
```

- **Change detection** — compares snapshots of both file systems to find created, modified, and deleted files
- **Incremental mode** — reuses previous snapshots to only process files that changed since last sync
- **Conflict resolution** — in two-way mode, detects when the same file changed on both sides and applies the chosen strategy
- **Watch mode** — combines push (local `onChange`) and pull (remote `shouldSync`) for near-real-time sync with minimal API calls

## License

MIT
