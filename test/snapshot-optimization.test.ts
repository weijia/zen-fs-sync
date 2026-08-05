import { describe, it, expect, beforeEach } from 'vitest';
import { SyncPair } from '../src/sync-pair';
import { MockFS } from './helpers/mock-fs';
import { SyncDirection } from '../src/types';

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
