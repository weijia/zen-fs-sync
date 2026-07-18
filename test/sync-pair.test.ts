import { describe, it, expect, beforeEach } from 'vitest';
import { SyncPair } from '../src/sync-pair';
import { ZenFSSync } from '../src/zen-fs-sync';
import { MockFS } from './helpers/mock-fs';
import { SyncDirection, ConflictStrategy, SyncPairState } from '../src/types';

// ---------------------------------------------------------------------------
// SyncPair 集成测试
// ---------------------------------------------------------------------------
describe('SyncPair', () => {
  let source: MockFS;
  let target: MockFS;

  beforeEach(() => {
    source = new MockFS({
      '/config/db/host.json': '{"host":"localhost","port":3306}',
      '/config/db/replica.json': '{"host":"replica"}',
      '/config/cache/redis.json': '{"ttl":60}',
    });
    target = new MockFS();
  });

  it('单向同步：将 source 全部复制到 target', async () => {
    const pair = new SyncPair(source, target, { direction: SyncDirection.OneWay }, '/');
    const result = await pair.sync();

    expect(result.filesCreated).toBe(3);
    expect(result.filesUpdated).toBe(0);
    expect(result.filesDeleted).toBe(0);
    expect(target.getContent('/config/db/host.json')).toBe(source.getContent('/config/db/host.json'));
    expect(target.getContent('/config/cache/redis.json')).toBe(source.getContent('/config/cache/redis.json'));
  });

  it('增量同步：再次同步无变更', async () => {
    const pair = new SyncPair(source, target, {}, '/');
    await pair.sync();
    const result = await pair.sync();

    expect(result.filesCreated).toBe(0);
    expect(result.filesUpdated).toBe(0);
  });

  it('同步新增文件', async () => {
    const pair = new SyncPair(source, target, {}, '/');
    await pair.sync();

    // 在 source 新增文件
    await source.writeFile('/config/new.json', '{"added":true}');
    const result = await pair.sync();

    expect(result.filesCreated).toBe(1);
    expect(target.getContent('/config/new.json')).toBe('{"added":true}');
  });

  it('同步删除文件', async () => {
    const pair = new SyncPair(source, target, {}, '/');
    await pair.sync();

    // 从 source 删除
    await source.unlink('/config/cache/redis.json');
    const result = await pair.sync();

    expect(result.filesDeleted).toBe(1);
    expect(await target.exists('/config/cache/redis.json')).toBe(false);
  });

  it('使用 filter 过滤', async () => {
    const pair = new SyncPair(
      source,
      target,
      {
        filter: { includePrefixes: ['/config/db'] },
      },
      '/',
    );
    const result = await pair.sync();

    expect(result.filesCreated).toBe(2);
    expect(target.getContent('/config/db/host.json')).toBeTruthy();
    expect(await target.exists('/config/cache/redis.json')).toBe(false);
  });

  it('同步后状态正确', async () => {
    const pair = new SyncPair(source, target, {}, '/');
    await pair.sync();

    const status = pair.getStatus();
    expect(status.state).toBe(SyncPairState.Idle);
    expect(status.totalSyncs).toBe(1);
    expect(status.lastResult).toBeDefined();
    expect(status.lastResult!.filesCreated).toBe(3);
  });

  it('dispose 后拒绝同步', async () => {
    const pair = new SyncPair(source, target, {}, '/');
    pair.dispose();

    await expect(pair.sync()).rejects.toThrow('disposed');
  });

  it('事件通知', async () => {
    const events: string[] = [];
    const pair = new SyncPair(source, target, {}, '/');

    pair.on('sync:start', (e) => events.push(e.type));
    pair.on('sync:end', (e) => events.push(e.type));

    await pair.sync();

    expect(events).toEqual(['sync:start', 'sync:end']);
  });
});

// ---------------------------------------------------------------------------
// ZenFSSync 管理器测试
// ---------------------------------------------------------------------------
describe('ZenFSSync', () => {
  it('addPair 创建并注册同步对', () => {
    const engine = new ZenFSSync();
    const source = new MockFS({ '/a.json': '{}' });
    const target = new MockFS();

    const pair = engine.addPair(source, target, {}, '/');

    expect(pair.pairId).toBeTruthy();
    expect(engine.listPairs()).toContain(pair.pairId);
  });

  it('sync 指定对', async () => {
    const engine = new ZenFSSync();
    const source = new MockFS({ '/a.json': '{"key":1}' });
    const target = new MockFS();

    const pair = engine.addPair(source, target, {}, '/');
    const result = await engine.sync(pair.pairId);

    expect(result.filesCreated).toBe(1);
    expect(target.getContent('/a.json')).toBe('{"key":1}');
  });

  it('syncAll 并行同步所有对', async () => {
    const engine = new ZenFSSync();

    const source1 = new MockFS({ '/x.json': '1' });
    const target1 = new MockFS();
    const source2 = new MockFS({ '/y.json': '2' });
    const target2 = new MockFS();

    engine.addPair(source1, target1, {}, '/');
    engine.addPair(source2, target2, {}, '/');

    const results = await engine.syncAll();

    expect(results.size).toBe(2);
    for (const [, result] of results) {
      expect(result.filesCreated).toBe(1);
    }
  });

  it('getStatus 查询状态', async () => {
    const engine = new ZenFSSync();
    const source = new MockFS({ '/a.json': '{}' });
    const target = new MockFS();

    const pair = engine.addPair(source, target, {}, '/');
    const status = engine.getStatus(pair.pairId);

    expect(status.pairId).toBe(pair.pairId);
    expect(status.state).toBe(SyncPairState.Idle);
    expect(status.totalSyncs).toBe(0);
  });

  it('removePair 移除同步对', () => {
    const engine = new ZenFSSync();
    const source = new MockFS();
    const target = new MockFS();

    const pair = engine.addPair(source, target, {}, '/');
    engine.removePair(pair.pairId);

    expect(engine.listPairs()).not.toContain(pair.pairId);
  });

  it('dispose 销毁所有对', () => {
    const engine = new ZenFSSync();
    engine.addPair(new MockFS(), new MockFS(), {}, '/');
    engine.addPair(new MockFS(), new MockFS(), {}, '/');

    engine.dispose();
    expect(engine.listPairs()).toHaveLength(0);
  });
});