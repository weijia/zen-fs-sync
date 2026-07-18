import { describe, it, expect } from 'vitest';
import { DefaultConflictResolver } from '../src/strategy/default';
import { ConflictStrategy } from '../src/types';

describe('DefaultConflictResolver', () => {
  const resolver = new DefaultConflictResolver();

  it('SourceWins 返回源端内容', async () => {
    const result = await resolver.resolve(
      '/test.json',
      '{"a":1}',
      '{"a":2}',
      ConflictStrategy.SourceWins,
    );
    expect(result.content).toBe('{"a":1}');
    expect(result.strategy).toBe(ConflictStrategy.SourceWins);
  });

  it('TargetWins 返回目标端内容', async () => {
    const result = await resolver.resolve(
      '/test.json',
      '{"a":1}',
      '{"a":2}',
      ConflictStrategy.TargetWins,
    );
    expect(result.content).toBe('{"a":2}');
    expect(result.strategy).toBe(ConflictStrategy.TargetWins);
  });

  it('Merge 对 JSON 文件做深合并', async () => {
    const result = await resolver.resolve(
      '/config/db.json',
      '{"host":"new-host","port":5432}',
      '{"host":"old-host","timeout":30}',
      ConflictStrategy.Merge,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.host).toBe('new-host');
    expect(parsed.port).toBe(5432);
    expect(parsed.timeout).toBe(30);
    expect(result.strategy).toBe(ConflictStrategy.Merge);
  });

  it('Merge 对非 JSON 文件回退到 SourceWins', async () => {
    const result = await resolver.resolve(
      '/config/readme.md',
      '# New',
      '# Old',
      ConflictStrategy.Merge,
    );
    expect(result.content).toBe('# New');
    expect(result.strategy).toBe(ConflictStrategy.SourceWins);
  });

  it('Merge 对无效 JSON 回退到 SourceWins', async () => {
    const result = await resolver.resolve(
      '/config/bad.json',
      'not-json-source',
      '{"valid":true}',
      ConflictStrategy.Merge,
    );
    expect(result.content).toBe('not-json-source');
    expect(result.strategy).toBe(ConflictStrategy.SourceWins);
  });

  it('Merge 处理嵌套对象', async () => {
    const target = JSON.stringify({
      db: { host: 'old', port: 3306 },
      cache: true,
    });
    const source = JSON.stringify({
      db: { host: 'new' },
      cache: false,
      log: { level: 'info' },
    });

    const result = await resolver.resolve(
      '/config/app.json',
      source,
      target,
      ConflictStrategy.Merge,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.db.host).toBe('new');
    expect(parsed.db.port).toBe(3306);
    expect(parsed.cache).toBe(false);
    expect(parsed.log.level).toBe('info');
  });
});