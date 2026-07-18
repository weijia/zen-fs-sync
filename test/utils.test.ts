import { describe, it, expect } from 'vitest';
import {
  normalizePath,
  resolvePath,
  isPathAllowed,
  diffSnapshots,
  deepMergeJSON,
  tryParseJSON,
  isJsonPath,
} from '../src/utils';
import { ChangeType, type FileSnapshot } from '../src/types';

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------
describe('normalizePath', () => {
  it('保留根路径', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('去除尾斜杠', () => {
    expect(normalizePath('/config/')).toBe('/config');
    expect(normalizePath('/a/b/c/')).toBe('/a/b/c');
  });

  it('标准化反斜杠', () => {
    expect(normalizePath('\\config\\db')).toBe('/config/db');
  });

  it('不变已规范的路径', () => {
    expect(normalizePath('/config/db')).toBe('/config/db');
  });
});

// ---------------------------------------------------------------------------
// resolvePath
// ---------------------------------------------------------------------------
describe('resolvePath', () => {
  it('拼接路径', () => {
    expect(resolvePath('/config', 'db/host.json')).toBe('/config/db/host.json');
  });

  it('处理相对路径带前导斜杠', () => {
    expect(resolvePath('/config', '/db/host.json')).toBe('/config/db/host.json');
  });

  it('空相对路径返回根', () => {
    expect(resolvePath('/config', '')).toBe('/config');
  });

  it('处理尾斜杠的 root', () => {
    expect(resolvePath('/config/', 'db.json')).toBe('/config/db.json');
  });
});

// ---------------------------------------------------------------------------
// isPathAllowed
// ---------------------------------------------------------------------------
describe('isPathAllowed', () => {
  it('无 filter 时全部通过', () => {
    expect(isPathAllowed('/any/path')).toBe(true);
  });

  it('excludePrefixes 排除匹配路径', () => {
    expect(
      isPathAllowed('/config/secrets/key.json', {
        excludePrefixes: ['/config/secrets'],
      }),
    ).toBe(false);
  });

  it('excludePrefixes 不匹配的路径通过', () => {
    expect(
      isPathAllowed('/config/db/host.json', {
        excludePrefixes: ['/config/secrets'],
      }),
    ).toBe(true);
  });

  it('includePrefixes 只允许匹配路径', () => {
    expect(
      isPathAllowed('/config/db/host.json', {
        includePrefixes: ['/config/db'],
      }),
    ).toBe(true);
    expect(
      isPathAllowed('/config/cache/x.json', {
        includePrefixes: ['/config/db'],
      }),
    ).toBe(false);
  });

  it('includeGlobs 匹配文件名', () => {
    expect(
      isPathAllowed('/config/db/host.json', {
        includeGlobs: ['*.json'],
      }),
    ).toBe(true);
    expect(
      isPathAllowed('/config/db/readme.md', {
        includeGlobs: ['*.json'],
      }),
    ).toBe(false);
  });

  it('includeGlobs 支持 ? 通配符', () => {
    expect(
      isPathAllowed('/config/a1.json', { includeGlobs: ['a?.json'] }),
    ).toBe(true);
    // a? 只匹配 1 个字符，"ab" 是 2 个字符不匹配
    expect(
      isPathAllowed('/config/abc.json', { includeGlobs: ['a?.json'] }),
    ).toBe(false);
  });

  it('exclude 优先于 include', () => {
    expect(
      isPathAllowed('/config/db/secret.json', {
        includePrefixes: ['/config/db'],
        excludePrefixes: ['/config/db/secret'],
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------
describe('diffSnapshots', () => {
  const makeSnap = (path: string, size: number, mtimeMs: number): FileSnapshot => ({
    path,
    size,
    mtimeMs,
  });

  it('检测新建文件', () => {
    const source = new Map([['/a.json', makeSnap('/a.json', 10, 1000)]]);
    const target = new Map();
    const changes = diffSnapshots(source, target);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/a.json');
    expect(changes[0].type).toBe(ChangeType.Created);
  });

  it('检测删除文件', () => {
    const source = new Map();
    const target = new Map([['/b.json', makeSnap('/b.json', 20, 2000)]]);
    const changes = diffSnapshots(source, target);
    expect(changes).toHaveLength(1);
    expect(changes[0].path).toBe('/b.json');
    expect(changes[0].type).toBe(ChangeType.Deleted);
  });

  it('检测修改文件 (mtime 不同)', () => {
    const source = new Map([['/c.json', makeSnap('/c.json', 30, 3001)]]);
    const target = new Map([['/c.json', makeSnap('/c.json', 30, 3000)]]);
    const changes = diffSnapshots(source, target);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe(ChangeType.Modified);
  });

  it('检测修改文件 (size 不同)', () => {
    const source = new Map([['/d.json', makeSnap('/d.json', 40, 4000)]]);
    const target = new Map([['/d.json', makeSnap('/d.json', 41, 4000)]]);
    const changes = diffSnapshots(source, target);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe(ChangeType.Modified);
  });

  it('相同快照无变更', () => {
    const snap = makeSnap('/e.json', 50, 5000);
    const source = new Map([['/e.json', snap]]);
    const target = new Map([['/e.json', snap]]);
    const changes = diffSnapshots(source, target);
    expect(changes).toHaveLength(0);
  });

  it('混合变更', () => {
    const source = new Map([
      ['/new.json', makeSnap('/new.json', 1, 100)],
      ['/modified.json', makeSnap('/modified.json', 20, 2001)],
      ['/unchanged.json', makeSnap('/unchanged.json', 30, 3000)],
    ]);
    const target = new Map([
      ['/modified.json', makeSnap('/modified.json', 20, 2000)],
      ['/unchanged.json', makeSnap('/unchanged.json', 30, 3000)],
      ['/deleted.json', makeSnap('/deleted.json', 40, 4000)],
    ]);
    const changes = diffSnapshots(source, target);
    expect(changes).toHaveLength(3);

    const types = changes.map((c) => c.type);
    expect(types).toContain(ChangeType.Created);
    expect(types).toContain(ChangeType.Modified);
    expect(types).toContain(ChangeType.Deleted);
  });
});

// ---------------------------------------------------------------------------
// deepMergeJSON
// ---------------------------------------------------------------------------
describe('deepMergeJSON', () => {
  it('合并简单对象', () => {
    expect(deepMergeJSON({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('源端覆盖同 key', () => {
    expect(deepMergeJSON({ a: 1, b: 1 }, { b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('递归合并嵌套对象', () => {
    const target = { db: { host: 'old', port: 3306 } };
    const source = { db: { host: 'new' }, cache: { ttl: 60 } };
    expect(deepMergeJSON(target, source)).toEqual({
      db: { host: 'new', port: 3306 },
      cache: { ttl: 60 },
    });
  });

  it('数组用源端替换', () => {
    expect(deepMergeJSON({ items: [1, 2] }, { items: [3, 4] })).toEqual({
      items: [3, 4],
    });
  });

  it('null/undefined 处理', () => {
    expect(deepMergeJSON(null, { a: 1 })).toEqual({ a: 1 });
    expect(deepMergeJSON({ a: 1 }, null)).toEqual({ a: 1 });
    expect(deepMergeJSON(undefined, 'hello')).toBe('hello');
  });

  it('原始值直接覆盖', () => {
    expect(deepMergeJSON('old', 'new')).toBe('new');
    expect(deepMergeJSON(42, 'str')).toBe('str');
  });
});

// ---------------------------------------------------------------------------
// tryParseJSON
// ---------------------------------------------------------------------------
describe('tryParseJSON', () => {
  it('解析有效 JSON', () => {
    expect(tryParseJSON('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJSON('[1,2,3]')).toEqual([1, 2, 3]);
    expect(tryParseJSON('"hello"')).toBe('hello');
    expect(tryParseJSON('42')).toBe(42);
  });

  it('无效 JSON 返回 undefined', () => {
    expect(tryParseJSON('not json')).toBeUndefined();
    expect(tryParseJSON('{broken')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isJsonPath
// ---------------------------------------------------------------------------
describe('isJsonPath', () => {
  it('识别 .json 后缀', () => {
    expect(isJsonPath('/config/db.json')).toBe(true);
    expect(isJsonPath('a.json')).toBe(true);
  });

  it('非 .json 返回 false', () => {
    expect(isJsonPath('/config/db.yaml')).toBe(false);
    expect(isJsonPath('/config/db')).toBe(false);
  });
});