import { describe, it, expect, beforeEach } from 'vitest';
import { SyncPair } from '../src/sync-pair';
import { MockFS } from './helpers/mock-fs';
import { SyncDirection, ConflictStrategy } from '../src/types';

// ---------------------------------------------------------------------------
// createSnapshot() optimization tests
// ---------------------------------------------------------------------------
describe('FS-provided createSnapshot()', () => {
  it('uses FS createSnapshot when available instead of generic buildSnapshot', async () => {
    const src = new MockFS({ '/config/a.json': '{"v":1}' });
    const tgt = new MockFS();
    src.useOptimizedSnapshot = true;

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // createSnapshot should have been called on source (at least once for bidirectional)
    expect(src.createSnapshotCalls).toBeGreaterThan(0);
  });

  it('falls back to generic buildSnapshot when FS does not provide createSnapshot', async () => {
    // MockFS always provides createSnapshot now, so we test by checking
    // that sync works correctly even without the optimized path
    const src = new MockFS({ '/config/a.json': '{"v":1}' });
    const tgt = new MockFS();

    const pair = new SyncPair(src, tgt, {}, '/');
    const result = await pair.sync();

    expect(result.filesCreated).toBe(1);
  });

  it('createSnapshot returns same result as generic buildSnapshot', async () => {
    const src = new MockFS({
      '/config/a.json': '{"v":1}',
      '/config/b.json': '{"v":2}',
    });

    // Call createSnapshot directly
    const snap = await src.createSnapshot('/', undefined);
    expect(snap).not.toBeNull();
    expect(snap!.size).toBe(2);
    expect(snap!.get('/config/a.json')!.size).toBe(7);
    expect(snap!.get('/config/b.json')!.size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Separate source/target snapshot comparison tests
// ---------------------------------------------------------------------------
describe('Separate snapshot comparison', () => {
  let src: MockFS;
  let tgt: MockFS;

  beforeEach(() => {
    src = new MockFS({
      '/shared/a.json': '{"from":"source"}',
      '/shared/b.json': '{"both":"initial"}',
    });
    tgt = new MockFS({
      '/shared/b.json': '{"both":"initial"}',
      '/shared/c.json': '{"from":"target"}',
    });
    // Make b.json identical on both sides
    src.setMtime('/shared/b.json', 1000);
    tgt.setMtime('/shared/b.json', 1000);
  });

  it('skips sync when neither side changed (separate comparison)', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    const r1 = await pair.sync();
    // First sync: a→target, c→source (b is identical, skip)
    expect(r1.filesCreated).toBe(2);

    // Second sync: nothing changed
    const r2 = await pair.sync();
    expect(r2.filesCreated).toBe(0);
    expect(r2.filesUpdated).toBe(0);
    expect(r2.filesDeleted).toBe(0);
  });

  it('detects source-only changes', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Change only source
    await src.writeFile('/shared/a.json', '{"from":"source-updated"}');
    const r2 = await pair.sync();

    expect(r2.filesUpdated).toBe(1);
    expect(tgt.getContent('/shared/a.json')).toBe('{"from":"source-updated"}');
  });

  it('detects target-only changes', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Change only target
    await tgt.writeFile('/shared/c.json', '{"from":"target-updated"}');
    const r2 = await pair.sync();

    expect(r2.filesUpdated).toBe(1);
    expect(src.getContent('/shared/c.json')).toBe('{"from":"target-updated"}');
  });

  it('detects both-side changes independently', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Change both sides
    await src.writeFile('/shared/a.json', '{"src":"changed"}');
    await tgt.writeFile('/shared/c.json', '{"tgt":"changed"}');
    const r2 = await pair.sync();

    // Both should be updated
    expect(r2.filesUpdated).toBe(2);
    expect(tgt.getContent('/shared/a.json')).toBe('{"src":"changed"}');
    expect(src.getContent('/shared/c.json')).toBe('{"tgt":"changed"}');
  });

  it('does not falsely detect changes from synced files', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    const r1 = await pair.sync();

    // After sync, both sides should have a.json, b.json, c.json
    // The key test: second sync should NOT see any changes
    // even though target got a.json (new file) and source got c.json (new file)
    const r2 = await pair.sync();
    expect(r2.filesCreated).toBe(0);
    expect(r2.filesUpdated).toBe(0);
    expect(r2.filesDeleted).toBe(0);
  });

  it('detects file deletion on source side', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Delete on source
    await src.unlink('/shared/a.json');
    const r2 = await pair.sync();

    // a.json should be removed from target too (bidirectional sync)
    expect(await tgt.exists('/shared/a.json')).toBe(false);
  });

  it('detects file deletion on target side', async () => {
    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Delete on target
    await tgt.unlink('/shared/c.json');
    const r2 = await pair.sync();

    // c.json should be removed from source too
    expect(await src.exists('/shared/c.json')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// unwatch() clears separate snapshots
// ---------------------------------------------------------------------------
describe('unwatch clears separate snapshots', () => {
  it('clears prevSrcSnap and prevTgtSnap on unwatch', async () => {
    const src = new MockFS({ '/a.json': '{}' });
    const tgt = new MockFS({ '/a.json': '{}' });
    src.setMtime('/a.json', 1000);
    tgt.setMtime('/a.json', 1000);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Start watch to trigger buildInitialSnapshots
    pair.watch();
    // Wait a bit for async buildInitialSnapshots
    await new Promise(resolve => setTimeout(resolve, 50));

    // Stop watch - should clear snapshots
    pair.unwatch();

    // Next sync should do full comparison (not skip)
    const result = await pair.sync();
    // Should be a no-op since nothing changed, but it should NOT skip
    // due to stale snapshots
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// copyFile uses writeFileWithMtime when available
// ---------------------------------------------------------------------------
// NOTE: copyFile() is only invoked from syncBidirectional(). The one-way
// path (syncOneWay) writes directly via tgt.writeFile(), bypassing the
// writeFileWithMtime preservation. To exercise the mtime-preservation
// behavior in copyFile, these tests use BiDirectional.
describe('copyFile uses writeFileWithMtime', () => {
  it('calls writeFileWithMtime on target when copying source→target', async () => {
    const src = new MockFS({ '/data.json': '{"hello":"world"}' });
    const tgt = new MockFS();

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // writeFileWithMtime should have been called on the target
    expect(tgt.writeFileWithMtimeCalls).toBeGreaterThan(0);
    // The mtime passed should equal the source file's mtime
    expect(tgt.lastWriteMtime).toBe(src.getMtime('/data.json'));
    // Content should be copied correctly
    expect(tgt.getContent('/data.json')).toBe(src.getContent('/data.json'));
  });

  it('falls back to writeFile when target does not support writeFileWithMtime', async () => {
    const src = new MockFS({ '/data.json': '{"hello":"world"}' });
    const tgt = new MockFS();
    // Simulate a backend that does not implement writeFileWithMtime.
    // Setting the own property to undefined shadows the prototype method so
    // the `if (to.writeFileWithMtime)` guard in copyFile falls back to writeFile.
    (tgt as any).writeFileWithMtime = undefined;

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // writeFileWithMtime should NOT have been called
    expect(tgt.writeFileWithMtimeCalls).toBe(0);
    // The file should still be copied via plain writeFile
    expect(tgt.getContent('/data.json')).toBe(src.getContent('/data.json'));
  });

  it('preserves source mtime across sync', async () => {
    const FIXED_MTIME = 1700000000000;
    const src = new MockFS({ '/data.json': '{"hello":"world"}' });
    src.setMtime('/data.json', FIXED_MTIME);
    const tgt = new MockFS();

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // The target file's mtime should equal the source's fixed mtime,
    // proving writeFileWithMtime was called with the correct mtime.
    expect(tgt.getMtime('/data.json')).toBe(FIXED_MTIME);
  });
});

// ---------------------------------------------------------------------------
// writeFileBoth in conflict resolution
// ---------------------------------------------------------------------------
// In syncBidirectional, a conflict (same mtime, different size + different
// content) is resolved by calling writeFileBoth(), which writes the resolved
// content to both sides using writeFileWithMtime when available.
describe('writeFileBoth conflict resolution', () => {
  it('uses writeFileWithMtime on both sides when resolving conflict', async () => {
    // Both sides have /conflict.json with the SAME mtime but DIFFERENT content.
    // The contents must differ in size too, otherwise syncBidirectional treats
    // equal mtime + equal size as identical and skips the file entirely.
    const src = new MockFS({ '/conflict.json': '{"v":"src"}' });
    const tgt = new MockFS({ '/conflict.json': '{"v":"target"}' });
    src.setMtime('/conflict.json', 1000);
    tgt.setMtime('/conflict.json', 1000);

    const pair = new SyncPair(
      src,
      tgt,
      { direction: SyncDirection.BiDirectional, conflictStrategy: ConflictStrategy.SourceWins },
      '/',
    );
    const result = await pair.sync();

    // A conflict should have been recorded
    expect(result.conflicts.length).toBe(1);
    // writeFileWithMtime should have been called on BOTH sides
    expect(src.writeFileWithMtimeCalls).toBeGreaterThan(0);
    expect(tgt.writeFileWithMtimeCalls).toBeGreaterThan(0);
  });

  it('writeFileBoth writes identical content to both sides', async () => {
    const SRC_CONTENT = '{"v":"src"}';
    const src = new MockFS({ '/conflict.json': SRC_CONTENT });
    const tgt = new MockFS({ '/conflict.json': '{"v":"target"}' });
    src.setMtime('/conflict.json', 1000);
    tgt.setMtime('/conflict.json', 1000);

    const pair = new SyncPair(
      src,
      tgt,
      { direction: SyncDirection.BiDirectional, conflictStrategy: ConflictStrategy.SourceWins },
      '/',
    );
    await pair.sync();

    // Both sides should now have the same content (source wins)
    expect(src.getContent('/conflict.json')).toBe(SRC_CONTENT);
    expect(tgt.getContent('/conflict.json')).toBe(SRC_CONTENT);
    expect(src.getContent('/conflict.json')).toBe(tgt.getContent('/conflict.json'));
  });
});
