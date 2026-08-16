/**
 * SyncableFS Compatibility Test Suite (Template)
 *
 * This template provides a comprehensive test suite that any SyncableFS
 * implementation must pass to be compatible with the zen-fs-sync engine.
 *
 * USAGE:
 *   1. Copy this file: cp test/syncable-fs-compat.template.ts test/<my-backend>-compat.test.ts
 *   2. Edit the `createFS()` factory function to instantiate YOUR backend
 *   3. Edit the `cleanupFS()` function to clean up resources between tests
 *   4. Run: npx vitest run test/<my-backend>-compat.test.ts
 *
 * The test suite is divided into 7 sections:
 *   1. Required methods — basic functionality
 *   2. Path handling — normalization, trailing slashes, root
 *   3. Directory operations — mkdir, readdir, nested dirs
 *   4. File round-trip — write → read → stat → delete
 *   5. Error handling — non-existent paths, type mismatches
 *   6. Optional methods — writeFileWithMtime, createSnapshot, onChange, shouldSync
 *   7. Sync engine integration — copyFile, buildSnapshot, ensureDir
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SyncableFS, FileStat, SyncFilter } from '../src/types';
import { isDirectory, isFile } from '../src/types';
import { buildSnapshot, ensureDir, walkFiles, writeFileWithMtimeFallback } from '../src/utils';

// ---------------------------------------------------------------------------
// CONFIG: Customize these for your backend
// ---------------------------------------------------------------------------

/**
 * Factory: create a fresh SyncableFS instance for testing.
 * Each test group calls this in beforeEach to get a clean state.
 *
 * TODO: Replace with your backend's constructor.
 */
async function createFS(): Promise<SyncableFS> {
  // Example: return new MyBackendFS({ ...config });
  throw new Error('Not implemented: replace createFS() with your backend factory');
}

/**
 * Cleanup: release resources after each test group.
 * Called after each test group completes.
 *
 * TODO: Replace with your backend's cleanup logic (close connections, delete temp files, etc.)
 */
async function cleanupFS(fs: SyncableFS): Promise<void> {
  // Example: await fs.dispose?.();
}

/**
 * Whether the backend supports optional methods.
 * Set to true/false based on your backend's capabilities.
 * Tests for optional methods are skipped if set to false.
 */
const CAPABILITIES = {
  writeFileWithMtime: false,  // Set to true if your backend implements writeFileWithMtime
  createSnapshot: false,       // Set to true if your backend implements createSnapshot
  onChange: false,             // Set to true if your backend implements onChange
  shouldSync: false,           // Set to true if your backend implements shouldSync
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SyncableFS Compatibility Tests', () => {
  let fs: SyncableFS;

  beforeEach(async () => {
    fs = await createFS();
  });

  afterEach(async () => {
    await cleanupFS(fs);
  });

  // ========================================================================
  // 1. Required Methods — Basic Functionality
  // ========================================================================

  describe('Required methods: basic functionality', () => {
    it('readdir() returns an array for an empty root', async () => {
      const entries = await fs.readdir('/');
      expect(Array.isArray(entries)).toBe(true);
    });

    it('writeFile() writes content that readFile() can read back', async () => {
      await fs.writeFile('/test.txt', 'hello world');
      const content = await fs.readFile('/test.txt', 'utf-8');
      expect(content).toBe('hello world');
    });

    it('readFile() without encoding returns Buffer/Uint8Array', async () => {
      await fs.writeFile('/binary.dat', 'data');
      const buffer = await fs.readFile('/binary.dat');
      expect(buffer).toBeDefined();
      // Buffer or Uint8Array — both have .length
      expect((buffer as any).length).toBe(4);
    });

    it('stat() returns FileStat with mode, size, mtimeMs for files', async () => {
      await fs.writeFile('/file.json', '{"a":1}');
      const stat = await fs.stat('/file.json');
      expect(stat.size).toBe(7);
      expect(stat.mtimeMs).toBeTypeOf('number');
      expect(isFile(stat)).toBe(true);
      expect(isDirectory(stat)).toBe(false);
    });

    it('unlink() deletes a file', async () => {
      await fs.writeFile('/temp.txt', 'temp');
      expect(await fs.exists('/temp.txt')).toBe(true);
      await fs.unlink('/temp.txt');
      expect(await fs.exists('/temp.txt')).toBe(false);
    });

    it('exists() returns false for non-existent path', async () => {
      expect(await fs.exists('/does-not-exist.txt')).toBe(false);
    });

    it('exists() returns true after writeFile', async () => {
      await fs.writeFile('/created.txt', 'content');
      expect(await fs.exists('/created.txt')).toBe(true);
    });

    it('mkdir() creates a directory', async () => {
      await fs.mkdir('/newdir');
      expect(await fs.exists('/newdir')).toBe(true);
      const stat = await fs.stat('/newdir');
      expect(isDirectory(stat)).toBe(true);
    });

    it('mkdir() with recursive creates parent directories', async () => {
      await fs.mkdir('/a/b/c', { recursive: true });
      expect(await fs.exists('/a')).toBe(true);
      expect(await fs.exists('/a/b')).toBe(true);
      expect(await fs.exists('/a/b/c')).toBe(true);
    });
  });

  // ========================================================================
  // 2. Path Handling — Normalization
  // ========================================================================

  describe('Path handling: normalization', () => {
    it('readdir() handles trailing slash in path', async () => {
      await fs.mkdir('/dir1');
      await fs.writeFile('/dir1/file.txt', 'content');

      const withoutSlash = await fs.readdir('/dir1');
      const withSlash = await fs.readdir('/dir1/');

      expect(withSlash).toEqual(withoutSlash);
      expect(withSlash).toContain('file.txt');
    });

    it('readdir() returns entry names, not full paths', async () => {
      await fs.mkdir('/mydir');
      await fs.writeFile('/mydir/a.txt', 'a');
      await fs.writeFile('/mydir/b.txt', 'b');

      const entries = await fs.readdir('/mydir');
      expect(entries).toContain('a.txt');
      expect(entries).toContain('b.txt');
      // Entries should NOT contain '/' (they're names, not paths)
      entries.forEach((e) => {
        expect(e).not.toContain('/');
      });
    });

    it('writeFile() to nested path works', async () => {
      await fs.mkdir('/parent/child', { recursive: true });
      await fs.writeFile('/parent/child/file.txt', 'nested');
      const content = await fs.readFile('/parent/child/file.txt', 'utf-8');
      expect(content).toBe('nested');
    });

    it('stat() on root directory returns directory type', async () => {
      const stat = await fs.stat('/');
      expect(isDirectory(stat)).toBe(true);
    });

    it('exists() on root returns true', async () => {
      expect(await fs.exists('/')).toBe(true);
    });
  });

  // ========================================================================
  // 3. Directory Operations
  // ========================================================================

  describe('Directory operations', () => {
    it('readdir() lists files and subdirectories', async () => {
      await fs.mkdir('/top');
      await fs.writeFile('/top/file1.txt', '1');
      await fs.writeFile('/top/file2.txt', '2');
      await fs.mkdir('/top/subdir');

      const entries = await fs.readdir('/top');
      expect(entries).toContain('file1.txt');
      expect(entries).toContain('file2.txt');
      expect(entries).toContain('subdir');
      expect(entries.length).toBe(3);
    });

    it('readdir() on empty directory returns empty array', async () => {
      await fs.mkdir('/empty');
      const entries = await fs.readdir('/empty');
      expect(entries).toEqual([]);
    });

    it('mkdir() on existing directory does not throw', async () => {
      await fs.mkdir('/exists');
      // Second mkdir should not throw (idempotent)
      await expect(fs.mkdir('/exists')).resolves.not.toThrow();
    });

    it('nested directories can be created and listed', async () => {
      await fs.mkdir('/a/b/c/d', { recursive: true });
      await fs.writeFile('/a/b/c/d/deep.txt', 'deep');

      const entries = await fs.readdir('/a/b/c/d');
      expect(entries).toContain('deep.txt');
    });

    it('stat() on subdirectory returns directory type', async () => {
      await fs.mkdir('/parent/sub');
      const stat = await fs.stat('/parent/sub');
      expect(isDirectory(stat)).toBe(true);
      expect(isFile(stat)).toBe(false);
    });
  });

  // ========================================================================
  // 4. File Round-Trip
  // ========================================================================

  describe('File round-trip: write → read → stat → delete', () => {
    it('full lifecycle of a file', async () => {
      // Write
      const content = '{"name":"test","value":42}';
      await fs.writeFile('/lifecycle.json', content);

      // Read back
      const read = await fs.readFile('/lifecycle.json', 'utf-8');
      expect(read).toBe(content);

      // Stat
      const stat = await fs.stat('/lifecycle.json');
      expect(stat.size).toBe(content.length);
      expect(isFile(stat)).toBe(true);
      const originalMtime = stat.mtimeMs;

      // Overwrite
      const newContent = '{"name":"test","value":99}';
      await fs.writeFile('/lifecycle.json', newContent);
      const newStat = await fs.stat('/lifecycle.json');
      expect(newStat.size).toBe(newContent.length);

      // Delete
      await fs.unlink('/lifecycle.json');
      expect(await fs.exists('/lifecycle.json')).toBe(false);
    });

    it('writeFile() overwrites existing file', async () => {
      await fs.writeFile('/overwrite.txt', 'original');
      await fs.writeFile('/overwrite.txt', 'replaced');
      const content = await fs.readFile('/overwrite.txt', 'utf-8');
      expect(content).toBe('replaced');
    });

    it('writeFile() with Uint8Array data', async () => {
      const data = new TextEncoder().encode('binary content');
      await fs.writeFile('/uint8.dat', data);
      const read = await fs.readFile('/uint8.dat', 'utf-8');
      expect(read).toBe('binary content');
    });

    it('multiple files in same directory', async () => {
      for (let i = 0; i < 10; i++) {
        await fs.writeFile(`/batch/file${i}.txt`, `content${i}`);
      }
      const entries = await fs.readdir('/batch');
      expect(entries.length).toBe(10);
      for (let i = 0; i < 10; i++) {
        const content = await fs.readFile(`/batch/file${i}.txt`, 'utf-8');
        expect(content).toBe(`content${i}`);
      }
    });
  });

  // ========================================================================
  // 5. Error Handling
  // ========================================================================

  describe('Error handling', () => {
    it('readFile() throws for non-existent file', async () => {
      await expect(fs.readFile('/nope.txt', 'utf-8')).rejects.toThrow();
    });

    it('stat() throws for non-existent path', async () => {
      await expect(fs.stat('/no/such/path')).rejects.toThrow();
    });

    it('unlink() throws for non-existent file', async () => {
      await expect(fs.unlink('/ghost.txt')).rejects.toThrow();
    });

    it('readdir() throws for non-existent directory', async () => {
      await expect(fs.readdir('/nonexistent-dir')).rejects.toThrow();
    });

    it('exists() never throws — even for invalid paths', async () => {
      // exists() should always return boolean, never throw
      const result1 = await fs.exists('/nonexistent');
      expect(result1).toBe(false);

      const result2 = await fs.exists('/a/b/c/d/e/f/g');
      expect(result2).toBe(false);
    });
  });

  // ========================================================================
  // 6. Optional Methods
  // ========================================================================

  describe('Optional: writeFileWithMtime', () => {
    beforeEach(function () {
      if (!CAPABILITIES.writeFileWithMtime) this.skip();
    });

    it('writeFileWithMtime() sets the specified mtime', async () => {
      const targetMtime = 1234567890000;
      await (fs as any).writeFileWithMtime('/mtime-test.txt', 'content', targetMtime);
      const stat = await fs.stat('/mtime-test.txt');
      expect(stat.mtimeMs).toBe(targetMtime);
    });

    it('writeFileWithMtime() preserves mtime through overwrite', async () => {
      const mtime1 = 1000000000000;
      await (fs as any).writeFileWithMtime('/preserve.txt', 'v1', mtime1);
      let stat = await fs.stat('/preserve.txt');
      expect(stat.mtimeMs).toBe(mtime1);

      const mtime2 = 2000000000000;
      await (fs as any).writeFileWithMtime('/preserve.txt', 'v2', mtime2);
      stat = await fs.stat('/preserve.txt');
      expect(stat.mtimeMs).toBe(mtime2);
    });
  });

  describe('Optional: createSnapshot', () => {
    beforeEach(function () {
      if (!CAPABILITIES.createSnapshot) this.skip();
    });

    it('createSnapshot() returns Map of relative paths', async () => {
      await fs.writeFile('/snap/a.txt', 'a');
      await fs.writeFile('/snap/b.txt', 'b');

      const snapshot = await fs.createSnapshot!('/snap');
      expect(snapshot).toBeInstanceOf(Map);
      expect(snapshot!.has('/a.txt') || snapshot!.has('a.txt')).toBe(true);
      expect(snapshot!.has('/b.txt') || snapshot!.has('b.txt')).toBe(true);
    });

    it('createSnapshot() includes size and mtimeMs', async () => {
      await fs.writeFile('/snap2/file.txt', 'content');
      const snapshot = await fs.createSnapshot!('/snap2');
      const entry = snapshot!.get('/file.txt') || snapshot!.get('file.txt');
      expect(entry).toBeDefined();
      expect(entry!.size).toBe(7);
      expect(entry!.mtimeMs).toBeTypeOf('number');
    });

    it('createSnapshot() returns null when FS unreachable', async () => {
      // If the backend can simulate unreachability, test it here.
      // Otherwise, skip this test.
      const snapshot = await fs.createSnapshot!('/nonexistent-root');
      // Some backends return empty Map, some return null.
      // Both are acceptable — just verify it doesn't throw.
      expect(snapshot === null || snapshot instanceof Map).toBe(true);
    });
  });

  describe('Optional: onChange', () => {
    beforeEach(function () {
      if (!CAPABILITIES.onChange) this.skip();
    });

    it('onChange callback is called after writeFile', async () => {
      let called = false;
      fs.onChange!(() => { called = true; });
      await fs.writeFile('/change-test.txt', 'content');
      // Give the callback a tick to fire (some backends fire async)
      await new Promise((r) => setTimeout(r, 10));
      expect(called).toBe(true);
    });

    it('onChange callback is called after unlink', async () => {
      await fs.writeFile('/change-unlink.txt', 'content');
      let called = false;
      fs.onChange!(() => { called = true; });
      await fs.unlink('/change-unlink.txt');
      await new Promise((r) => setTimeout(r, 10));
      expect(called).toBe(true);
    });
  });

  describe('Optional: shouldSync', () => {
    beforeEach(function () {
      if (!CAPABILITIES.shouldSync) this.skip();
    });

    it('shouldSync() returns boolean', async () => {
      const result = await fs.shouldSync!();
      expect(typeof result).toBe('boolean');
    });

    it('shouldSync() returns false when no external changes', async () => {
      // First call initializes baseline — may return true
      await fs.shouldSync!();
      // Second call with no changes should return false
      const result = await fs.shouldSync!();
      expect(result).toBe(false);
    });
  });

  // ========================================================================
  // 7. Sync Engine Integration
  // ========================================================================

  describe('Sync engine integration: buildSnapshot', () => {
    it('buildSnapshot() produces correct snapshot via generic walker', async () => {
      await fs.mkdir('/sync-test');
      await fs.writeFile('/sync-test/a.txt', 'aaa');
      await fs.writeFile('/sync-test/b.txt', 'bbb');
      await fs.mkdir('/sync-test/sub');
      await fs.writeFile('/sync-test/sub/c.txt', 'ccc');

      const snapshot = await buildSnapshot(fs, '/sync-test', undefined);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.size).toBe(3); // a.txt, b.txt, sub/c.txt

      const aEntry = snapshot!.get('/a.txt');
      expect(aEntry).toBeDefined();
      expect(aEntry!.size).toBe(3);

      const cEntry = snapshot!.get('/sub/c.txt');
      expect(cEntry).toBeDefined();
      expect(cEntry!.size).toBe(3);
    });

    it('buildSnapshot() returns null for unreachable FS', async () => {
      const snapshot = await buildSnapshot(fs, '/totally-nonexistent-path', undefined);
      // Should be null (unreachable) or empty Map (reached but empty)
      expect(snapshot === null || snapshot!.size === 0).toBe(true);
    });
  });

  describe('Sync engine integration: ensureDir', () => {
    it('ensureDir() creates all parent directories', async () => {
      await ensureDir(fs, '/ensure/a/b/c');
      expect(await fs.exists('/ensure')).toBe(true);
      expect(await fs.exists('/ensure/a')).toBe(true);
      expect(await fs.exists('/ensure/a/b')).toBe(true);
      expect(await fs.exists('/ensure/a/b/c')).toBe(true);
    });

    it('ensureDir() is idempotent', async () => {
      await ensureDir(fs, '/idemp/p1/p2');
      // Calling again should not throw
      await ensureDir(fs, '/idemp/p1/p2');
      expect(await fs.exists('/idemp/p1/p2')).toBe(true);
    });
  });

  describe('Sync engine integration: walkFiles', () => {
    it('walkFiles() returns all file paths relative to root', async () => {
      await fs.mkdir('/walk');
      await fs.writeFile('/walk/file1.txt', '1');
      await fs.writeFile('/walk/file2.txt', '2');
      await fs.mkdir('/walk/subdir');
      await fs.writeFile('/walk/subdir/file3.txt', '3');

      const files = await walkFiles(fs, '/walk', undefined);
      expect(files.length).toBe(3);
      // Paths should be relative (starting with /)
      files.forEach((p) => {
        expect(p.startsWith('/')).toBe(true);
      });
    });
  });

  describe('Sync engine integration: writeFileWithMtimeFallback', () => {
    it('falls back to plain writeFile when mtime not provided', async () => {
      await writeFileWithMtimeFallback(fs, '/fallback.txt', 'content', undefined);
      const content = await fs.readFile('/fallback.txt', 'utf-8');
      expect(content).toBe('content');
    });

    it('uses writeFileWithMtime when mtime is provided and backend supports it', async function () {
      if (!CAPABILITIES.writeFileWithMtime) this.skip();
      const mtime = 999999999999;
      await writeFileWithMtimeFallback(fs, '/with-mtime.txt', 'content', mtime);
      const stat = await fs.stat('/with-mtime.txt');
      expect(stat.mtimeMs).toBe(mtime);
    });
  });

  // ========================================================================
  // 8. Concurrency & State Integrity
  // ========================================================================

  describe('Concurrency and state integrity', () => {
    it('parallel writeFile calls do not corrupt each other', async () => {
      await fs.mkdir('/concurrent');
      const promises: Promise<void>[] = [];
      for (let i = 0; i < 5; i++) {
        promises.push(fs.writeFile(`/concurrent/file${i}.txt`, `content${i}`));
      }
      await Promise.all(promises);

      for (let i = 0; i < 5; i++) {
        const content = await fs.readFile(`/concurrent/file${i}.txt`, 'utf-8');
        expect(content).toBe(`content${i}`);
      }
    });

    it('parallel mkdir calls do not conflict', async () => {
      await Promise.all([
        fs.mkdir('/par/a'),
        fs.mkdir('/par/b'),
        fs.mkdir('/par/c'),
      ]);
      expect(await fs.exists('/par/a')).toBe(true);
      expect(await fs.exists('/par/b')).toBe(true);
      expect(await fs.exists('/par/c')).toBe(true);
    });
  });
});
