---
name: "syncable-fs-impl"
description: "Guide for creating a SyncableFS backend implementation with a built-in compatibility test suite. Invoke when user wants to implement a new filesystem backend for zen-fs-sync, or needs to make an existing FS compatible with the sync engine."
---

# SyncableFS Implementation Guide

This skill guides you through creating a new `SyncableFS` implementation that is compatible with the zen-fs-sync sync engine. It includes a design checklist, implementation template, and a ready-to-use compatibility test suite.

## When to Invoke

- User wants to create a new filesystem backend for zen-fs-sync
- User needs to adapt an existing filesystem (e.g., S3, Dropbox, WebDAV) to work with the sync engine
- User asks "how to make my FS syncable" or "how to implement SyncableFS"
- User wants to verify an existing SyncableFS implementation passes compatibility tests

## Step 1: Understand the Interface

`SyncableFS` requires 8 async methods and supports 5 optional methods. Read `docs/SyncableFS.md` for the full specification.

### Required Methods (must implement all)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `readdir` | `(path: string) => Promise<string[]>` | List directory entries |
| `readFile` | `(path: string, encoding?: BufferEncoding) => Promise<string \| Buffer>` | Read file content |
| `writeFile` | `(path: string, data: string \| Uint8Array) => Promise<void>` | Write file content |
| `unlink` | `(path: string) => Promise<void>` | Delete a file |
| `stat` | `(path: string) => Promise<FileStat>` | Get file metadata (mode, size, mtimeMs) |
| `mkdir` | `(path: string, options?: { recursive?: boolean }) => Promise<void>` | Create directory |
| `exists` | `(path: string) => Promise<boolean>` | Check if path exists |

### Optional Methods (implement for better performance)

| Method | When to Implement | Benefit |
|--------|-------------------|---------|
| `backendName` | Always (simple string) | Better log readability |
| `writeFileWithMtime` | When native mtime is imprecise (e.g., Git commit time) | Preserves source file's real mtime during sync |
| `onChange` | When the FS can detect local writes in real-time (e.g., IndexedDB) | Push-based change detection, eliminates polling |
| `shouldSync` | For remote backends (e.g., RemoteStorage, GitHub) | Detects remote changes without full scan |
| `createSnapshot` | When the backend has a batch API (e.g., Git tree API) | Avoids per-file stat() calls during snapshot |

## Step 2: Implementation Template

```typescript
import type { FileStat, FileSnapshot, SyncFilter, SyncableFS } from 'zen-fs-sync';

export class MyBackendFS implements SyncableFS {
  backendName = 'MyBackend';

  constructor(config: MyBackendConfig) {
    // Initialize connection, auth, etc.
  }

  // ── Required Methods ──────────────────────────────────

  async readdir(path: string): Promise<string[]> {
    // 1. Normalize path (handle trailing slash, double slash)
    // 2. Call backend API to list directory
    // 3. Return array of entry names (NOT full paths)
    // 4. Throw on error (non-existent dir, no permission)
  }

  async readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer> {
    // 1. Call backend API to download file
    // 2. If encoding provided (e.g., 'utf-8'), return string
    // 3. If no encoding, return Buffer / Uint8Array
    // 4. Throw on not-found
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    // 1. Convert data to backend format (e.g., ArrayBuffer for HTTP PUT)
    // 2. Upload to backend
    // 3. Auto-create parent directories if needed
    // 4. Update internal caches (dir listing, existence)
  }

  async unlink(path: string): Promise<void> {
    // 1. Call backend API to delete file
    // 2. Update internal caches (remove from dir listing, set existence=false)
    // 3. Throw on not-found (sync engine catches and counts as skipped)
  }

  async stat(path: string): Promise<FileStat> {
    // 1. Check if it's a file or directory
    // 2. Return { mode, size, mtimeMs }
    //    - File: mode = 0o100644
    //    - Dir:  mode = 0o040755
    // 3. Throw on not-found
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // 1. If recursive, create all parent dirs
    // 2. Call backend API to create directory
    //    - RemoteStorage: PUT path/.keep
    //    - GitHub: create file in path (auto-creates dir)
    //    - S3: create zero-length object with folder key
  }

  async exists(path: string): Promise<boolean> {
    // 1. Check cache first (if available)
    // 2. Fall back to stat() — return true if no error, false if ENOENT
    // 3. NEVER throw — always return boolean
  }

  // ── Optional Methods ──────────────────────────────────

  /**
   * Only implement if backend's native mtime is imprecise.
   * Common approach: write a .mtime sidecar file.
   */
  async writeFileWithMtime?(path: string, data: string | Uint8Array, mtimeMs: number): Promise<void> {
    await this.writeFile(path, data);
    await this.writeFile(path + '.mtime', String(mtimeMs));
  }

  /**
   * Only implement for local FS that can detect writes in real-time.
   * Store callback and invoke it after every writeFile/unlink.
   */
  onChange?(callback: () => void): void {
    this.changeCallbacks.push(callback);
  }

  /**
   * Only implement for remote backends.
   * Compare a baseline (e.g., ETag, commit SHA) with current remote state.
   * Return true if remote changed since last check.
   * Update baseline after each check.
   */
  async shouldSync?(): Promise<boolean> {
    const currentEtag = await this.fetchEtag('/');
    if (currentEtag !== this.lastEtag) {
      this.lastEtag = currentEtag;
      return true;
    }
    return false;
  }

  /**
   * Only implement when backend has a batch metadata API.
   * Must return ALL files under root, as a Map of relative-path → FileSnapshot.
   * Return null if the FS is unreachable.
   */
  async createSnapshot?(root: string, filter?: SyncFilter): Promise<Map<string, FileSnapshot> | null> {
    // Use backend-specific batch API (e.g., Git tree, S3 list-objects-v2)
    // Apply filter if provided
    // Return null if unreachable
  }
}
```

## Step 3: Path Handling Rules

The sync engine calls methods with absolute paths. Follow these rules:

1. **Normalize trailing slashes**: `readdir('/foo/')` and `readdir('/foo')` must behave identically
2. **Directory URLs**: Some backends (RemoteStorage) require trailing `/` in URLs for directories, and must NOT have trailing `/` for file URLs. Handle this in `buildUrl` or equivalent
3. **Root path**: `/` or `''` (empty string) both mean root. Handle both
4. **Path separators**: Always use `/`, never `\`
5. **Relative paths from readdir**: Return only entry names (`'config.json'`), not full paths (`'/foo/config.json'`)

## Step 4: Cache Management

For remote backends, implement internal caches to avoid repeated network requests:

| Cache Type | What to Cache | TTL | Invalidation |
|------------|--------------|-----|--------------|
| Dir listing | `Map<dirPath, entries[]>` | 5 min | Clear parent dir on writeFile/unlink/mkdir |
| Existence | `Map<filePath, boolean>` | 10s (positive) / 15s (negative) | Clear on writeFile/unlink |
| Stat | `Map<path, FileStat>` | Same as dir listing | Clear on any write |

Key rules:
- Cache must be in-memory (not persisted across sessions unless explicitly configured)
- Write operations must patch the cache (add entry on writeFile, remove on unlink) instead of invalidating and re-fetching
- `exists()` should never throw — always return boolean

## Step 5: Mtime Preservation

The sync engine uses `mtimeMs` to detect changes. If your backend's native mtime is imprecise:

1. Implement `writeFileWithMtime(path, data, mtimeMs)`
2. Store the precise mtime in a sidecar file (e.g., `path.mtime`)
3. In `stat()`, check for sidecar file and use its value if available
4. In `readdir()`, exclude `.mtime` files from results (or the sync engine will sync them)

## Step 6: Run Compatibility Tests

After implementing, run the compatibility test suite to verify correctness:

```bash
# Copy the template and customize the factory function
cp test/syncable-fs-compat.template.ts test/my-backend-compat.test.ts

# Edit the factory function to create your backend instance
# Then run:
npx vitest run test/my-backend-compat.test.ts
```

The compatibility test suite verifies:
- All 8 required methods work correctly
- Path normalization (trailing slashes, root path)
- readdir returns entry names (not full paths)
- stat returns correct mode for files vs directories
- exists never throws
- mkdir creates parent directories
- writeFile auto-creates parent dirs
- unlink throws on non-existent file
- Optional methods work if implemented
- Round-trip: writeFile → readFile returns same content
- Nested directory structure works
- Empty directories are handled
- Concurrent operations don't corrupt state
```
