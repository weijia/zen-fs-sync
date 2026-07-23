/**
 * zen-fs-sync — 内部工具函数
 */

import {
  ChangeType,
  isDirectory,
  isFile,
  type FileSnapshot,
  type SyncFilter,
  type SyncableFS,
} from './types';
import { createLogger } from './logger';

const log = createLogger('detector');

// ---------------------------------------------------------------------------
// 路径规范化
// ---------------------------------------------------------------------------

/**
 * 将路径统一为不带尾斜杠的绝对路径。
 * 确保 root 和文件路径拼接时不会出现 `//` 或缺少 `/` 的情况。
 */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  // 去除尾斜杠（但保留根 '/'）
  if (s.length > 1 && s.endsWith('/')) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * 拼接 root 和相对路径，返回规范化绝对路径。
 */
export function resolvePath(root: string, relative: string): string {
  const r = normalizePath(root);
  const rel = relative.startsWith('/') ? relative.slice(1) : relative;
  if (!rel) return r;
  const joined = r === '/' ? `/${rel}` : `${r}/${rel}`;
  return normalizePath(joined);
}

// ---------------------------------------------------------------------------
// 路径过滤
// ---------------------------------------------------------------------------

/**
 * 检查路径是否被 filter 允许通过。
 */
export function isPathAllowed(path: string, filter?: SyncFilter): boolean {
  if (!filter) return true;
  const normalized = normalizePath(path);

  // excludePrefixes 优先
  if (filter.excludePrefixes?.length) {
    for (const prefix of filter.excludePrefixes) {
      if (normalized.startsWith(normalizePath(prefix))) return false;
    }
  }

  // includePrefixes：空数组 = 全部通过
  if (filter.includePrefixes?.length) {
    let matched = false;
    for (const prefix of filter.includePrefixes) {
      if (normalized.startsWith(normalizePath(prefix))) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  // includeGlobs：简易文件名匹配（不引入完整 glob 库）
  if (filter.includeGlobs?.length) {
    const fileName = normalized.split('/').pop()!;
    const globMatched = filter.includeGlobs.some((g) =>
      simpleGlobMatch(fileName, g),
    );
    if (!globMatched) return false;
  }

  return true;
}

/**
 * 极简 glob 匹配，仅支持 *（任意字符序列）和 ?（单个字符）。
 */
function simpleGlobMatch(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return regex.test(str);
}

// ---------------------------------------------------------------------------
// 文件系统遍历
// ---------------------------------------------------------------------------

/**
 * 递归遍历文件系统，收集所有文件的相对路径。
 * 返回的路径是相对于 root 的、以 / 开头的路径。
 */
export async function walkFiles(
  fs: SyncableFS,
  root: string,
  filter?: SyncFilter,
): Promise<string[]> {
  const results: string[] = [];
  const normalizedRoot = normalizePath(root);

  async function visit(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // 目录不存在或无权限
    }

    for (const entry of entries) {
      if (entry === '.zenfs-sync') continue;

      const fullPath = resolvePath(dir, entry);
      let relPath = fullPath.slice(normalizedRoot.length) || '/';
      if (!relPath.startsWith('/')) relPath = '/' + relPath;

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (isDirectory(stat)) {
        await visit(fullPath);
      } else if (isFile(stat)) {
        if (!isPathAllowed(relPath, filter)) continue;
        results.push(relPath);
      }
    }
  }

  await visit(normalizedRoot);
  return results;
}

// ---------------------------------------------------------------------------
// 快照构建
// ---------------------------------------------------------------------------

/**
 * 为文件系统在 root 下构建快照映射。
 */
export async function buildSnapshot(
  fs: SyncableFS,
  root: string,
  filter?: SyncFilter,
): Promise<Map<string, FileSnapshot> | null> {
  const normalizedRoot = normalizePath(root);
  const fsName = fs.backendName || 'unknown';

  // Guard: if root readdir fails, the FS is unreachable — return null
  // so callers can skip this sync cycle instead of treating it as empty.
  try {
    await fs.readdir(normalizedRoot);
  } catch {
    console.warn(`[zen-fs-sync] buildSnapshot(${fsName}): unreachable, returning null`);
    return null;
  }

  const files = await walkFiles(fs, root, filter);
  const snapshot = new Map<string, FileSnapshot>();

  for (const relPath of files) {
    const fullPath = resolvePath(normalizedRoot, relPath);
    try {
      const stat = await fs.stat(fullPath);
      snapshot.set(relPath, {
        path: relPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      // 文件可能在遍历后被删除，跳过
    }
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// 确保目录存在
// ---------------------------------------------------------------------------

/**
 * 递归创建目录（如果不存在）。
 */
export async function ensureDir(
  fs: SyncableFS,
  dirPath: string,
): Promise<void> {
  const normalized = normalizePath(dirPath);
  const parts = normalized.split('/').filter(Boolean);
  let current = '';

  for (const part of parts) {
    current += `/${part}`;
    const exists = await fs.exists(current);
    if (!exists) {
      await fs.mkdir(current, { recursive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// ID 生成
// ---------------------------------------------------------------------------

let counter = 0;

export function generatePairId(): string {
  counter++;
  return `sync-${Date.now().toString(36)}-${counter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// JSON 深合并
// ---------------------------------------------------------------------------

/**
 * 递归合并两个 JSON 对象。
 * 数组采用源端替换策略。
 * 原始值直接用 source 覆盖。
 */
export function deepMergeJSON(target: unknown, source: unknown): unknown {
  if (source === undefined || source === null) return target;
  if (target === undefined || target === null) return source;
  if (typeof source !== 'object' || typeof target !== 'object') return source;
  if (Array.isArray(source) || Array.isArray(target)) return source;

  const result = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const sv = (source as Record<string, unknown>)[key];
    const tv = (target as Record<string, unknown>)[key];
    result[key] = deepMergeJSON(tv, sv);
  }
  return result;
}

/**
 * 尝试将字符串解析为 JSON，失败返回 undefined。
 */
export function tryParseJSON(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 判断路径是否可能为 JSON 文件。
 */
export function isJsonPath(path: string): boolean {
  return path.endsWith('.json');
}

// ---------------------------------------------------------------------------
// 只读快照集合差异比较
// ---------------------------------------------------------------------------

/**
 * 比较两组快照，返回 source 相对于 target 的变更。
 */
export function diffSnapshots(
  source: Map<string, FileSnapshot> | null,
  target: Map<string, FileSnapshot> | null,
): import('./types').ChangeEntry[] {
  // If either snapshot is null (FS unreachable), skip — don't infer deletions.
  if (source === null || target === null) {
    console.log(`[zen-fs-sync] diffSnapshots: one side is null (unreachable) — skipping to prevent false deletions`);
    return [];
  }

  const changes: import('./types').ChangeEntry[] = [];

  // source 中有、target 中没有 → created
  for (const [path, snap] of source) {
    if (!target.has(path)) {
      changes.push({ path, type: ChangeType.Created, sourceSnapshot: snap });
    } else {
      const targetSnap = target.get(path)!;
      if (
        snap.mtimeMs !== targetSnap.mtimeMs ||
        snap.size !== targetSnap.size
      ) {
        changes.push({
          path,
          type: ChangeType.Modified,
          sourceSnapshot: snap,
          targetSnapshot: targetSnap,
        });
      }
    }
  }

  // target 中有、source 中没有 → deleted
  for (const [path, snap] of target) {
    if (!source.has(path)) {
      changes.push({ path, type: ChangeType.Deleted, targetSnapshot: snap });
    }
  }

  return changes;
}