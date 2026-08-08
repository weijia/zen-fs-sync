import { describe, it, expect, beforeEach } from 'vitest';
import { SyncPair } from '../src/sync-pair';
import { MockFS } from './helpers/mock-fs';
import { SyncDirection } from '../src/types';

// ---------------------------------------------------------------------------
// syncBidirectional mtime normalization
// ---------------------------------------------------------------------------
// When both sides have the same file with different mtime but identical
// content, the sync engine should normalize both sides' mtime to the oldest
// value (Math.min) instead of endlessly re-reading and re-comparing.
describe('syncBidirectional mtime normalization (content identical, mtime differs)', () => {

  it('normalizes mtime to oldest when content is identical', async () => {
    const OLDER_MTIME = 1000;
    const NEWER_MTIME = 5000;

    const src = new MockFS({ '/shared/config.json': '{"v":1}' });
    const tgt = new MockFS({ '/shared/config.json': '{"v":1}' });
    src.setMtime('/shared/config.json', NEWER_MTIME);
    tgt.setMtime('/shared/config.json', OLDER_MTIME);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    const result = await pair.sync();

    // Both sides should now have the oldest mtime
    expect(src.getMtime('/shared/config.json')).toBe(OLDER_MTIME);
    expect(tgt.getMtime('/shared/config.json')).toBe(OLDER_MTIME);

    // It should be counted as skipped, not updated
    expect(result.filesUpdated).toBe(0);
    expect(result.filesSkipped).toBe(1);
  });

  it('does not re-normalize on subsequent sync (mtime already equal)', async () => {
    const OLDER_MTIME = 1000;
    const NEWER_MTIME = 5000;

    const src = new MockFS({ '/shared/config.json': '{"v":1}' });
    const tgt = new MockFS({ '/shared/config.json': '{"v":1}' });
    src.setMtime('/shared/config.json', NEWER_MTIME);
    tgt.setMtime('/shared/config.json', OLDER_MTIME);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');

    // First sync: normalizes mtime
    const r1 = await pair.sync();
    expect(r1.filesSkipped).toBe(1);

    // Record call counts after first sync
    const srcCallsAfterFirst = src.writeFileWithMtimeCalls;
    const tgtCallsAfterFirst = tgt.writeFileWithMtimeCalls;

    // Second sync: mtime now equal, should skip entirely
    const r2 = await pair.sync();
    expect(r2.filesSkipped).toBe(0);
    expect(r2.filesUpdated).toBe(0);
    expect(r2.filesCreated).toBe(0);

    // No additional writeFileWithMtime calls
    expect(src.writeFileWithMtimeCalls).toBe(srcCallsAfterFirst);
    expect(tgt.writeFileWithMtimeCalls).toBe(tgtCallsAfterFirst);
  });

  it('copies newer content when content actually differs', async () => {
    const OLDER_MTIME = 1000;
    const NEWER_MTIME = 5000;

    const src = new MockFS({ '/shared/config.json': '{"v":"newer"}' });
    const tgt = new MockFS({ '/shared/config.json': '{"v":"older"}' });
    // Source has newer mtime → source should win
    src.setMtime('/shared/config.json', NEWER_MTIME);
    tgt.setMtime('/shared/config.json', OLDER_MTIME);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    const result = await pair.sync();

    // Target should get the newer content from source
    expect(tgt.getContent('/shared/config.json')).toBe('{"v":"newer"}');
    expect(result.filesUpdated).toBe(1);
  });

  it('copies from target to source when target has newer content', async () => {
    const OLDER_MTIME = 1000;
    const NEWER_MTIME = 5000;

    const src = new MockFS({ '/shared/config.json': '{"v":"older"}' });
    const tgt = new MockFS({ '/shared/config.json': '{"v":"newer"}' });
    // Target has newer mtime → target should win
    src.setMtime('/shared/config.json', OLDER_MTIME);
    tgt.setMtime('/shared/config.json', NEWER_MTIME);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    const result = await pair.sync();

    // Source should get the newer content from target
    expect(src.getContent('/shared/config.json')).toBe('{"v":"newer"}');
    expect(result.filesUpdated).toBe(1);
  });

  it('handles multiple files: some normalize, some update', async () => {
    const src = new MockFS({
      '/shared/identical.json': '{"v":1}',
      '/shared/different.json': '{"src":true}',
    });
    const tgt = new MockFS({
      '/shared/identical.json': '{"v":1}',
      '/shared/different.json': '{"tgt":true}',
    });
    // identical.json: same content, different mtime → normalize
    src.setMtime('/shared/identical.json', 5000);
    tgt.setMtime('/shared/identical.json', 1000);
    // different.json: different content, different mtime → copy newer
    src.setMtime('/shared/different.json', 5000);
    tgt.setMtime('/shared/different.json', 1000);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    const result = await pair.sync();

    // identical.json: both sides normalized to 1000 (oldest)
    expect(src.getMtime('/shared/identical.json')).toBe(1000);
    expect(tgt.getMtime('/shared/identical.json')).toBe(1000);

    // different.json: source (newer) copied to target
    expect(tgt.getContent('/shared/different.json')).toBe('{"src":true}');

    // 1 updated (different.json), 1 skipped (identical.json)
    expect(result.filesUpdated).toBe(1);
    expect(result.filesSkipped).toBe(1);
  });

  it('calls writeFileWithMtime on both sides during normalization', async () => {
    const src = new MockFS({ '/file.json': '{"v":1}' });
    const tgt = new MockFS({ '/file.json': '{"v":1}' });
    src.setMtime('/file.json', 5000);
    tgt.setMtime('/file.json', 1000);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Both sides should have had writeFileWithMtime called
    expect(src.writeFileWithMtimeCalls).toBeGreaterThan(0);
    expect(tgt.writeFileWithMtimeCalls).toBeGreaterThan(0);
  });

  it('skips normalization for sides without writeFileWithMtime support', async () => {
    const OLDER_MTIME = 1000;
    const NEWER_MTIME = 5000;

    const src = new MockFS({ '/file.json': '{"v":1}' });
    const tgt = new MockFS({ '/file.json': '{"v":1}' });
    // Target doesn't support writeFileWithMtime
    (tgt as any).writeFileWithMtime = undefined;
    src.setMtime('/file.json', NEWER_MTIME);
    tgt.setMtime('/file.json', OLDER_MTIME);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Source side should still be normalized (it supports writeFileWithMtime)
    expect(src.getMtime('/file.json')).toBe(OLDER_MTIME);
    // Target side mtime stays unchanged (can't be set externally)
    expect(tgt.getMtime('/file.json')).toBe(OLDER_MTIME);
    // Target should NOT have had writeFileWithMtime called
    expect(tgt.writeFileWithMtimeCalls).toBe(0);
    // Source SHOULD have had it called
    expect(src.writeFileWithMtimeCalls).toBeGreaterThan(0);
  });

  it('normalizes with large mtime gap (second vs millisecond precision)', async () => {
    // Simulates the real-world case where one backend has second-level
    // precision (e.g. Git commit time) and another has millisecond precision.
    const SEC_MTIME = 1700000000;      // seconds precision (e.g. 2023-11-14)
    const MS_MTIME = 1700000000123;    // millisecond precision

    const src = new MockFS({ '/data.json': '{"big":"data"}' });
    const tgt = new MockFS({ '/data.json': '{"big":"data"}' });
    src.setMtime('/data.json', MS_MTIME);
    tgt.setMtime('/data.json', SEC_MTIME);

    const pair = new SyncPair(src, tgt, { direction: SyncDirection.BiDirectional }, '/');
    await pair.sync();

    // Both should normalize to the older (seconds) mtime
    expect(src.getMtime('/data.json')).toBe(SEC_MTIME);
    expect(tgt.getMtime('/data.json')).toBe(SEC_MTIME);
  });
});
