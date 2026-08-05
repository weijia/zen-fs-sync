/**
 * 测试用内存文件系统 Mock，实现 SyncableFS 接口
 */

import type { FileSnapshot, FileStat, SyncFilter, SyncableFS } from '../src/types';

export interface MockFile {
  content: string;
  mtimeMs: number;
}

export class MockFS implements SyncableFS {
  private files = new Map<string, MockFile>();
  private dirs = new Set<string>();
  private mtimeCounter = 1000;
  /** Tracks how many times createSnapshot was called (test verification) */
  createSnapshotCalls = 0;
  /** When true, MockFS provides its own createSnapshot (optimized path) */
  useOptimizedSnapshot = false;

  constructor(initial?: Record<string, string>) {
    this.dirs.add('/');
    if (initial) {
      for (const [path, content] of Object.entries(initial)) {
        this.files.set(path, { content, mtimeMs: this.nextMtime() });
        // 自动创建父目录
        const parts = path.split('/').filter(Boolean);
        let dir = '';
        for (let i = 0; i < parts.length - 1; i++) {
          dir += `/${parts[i]}`;
          this.dirs.add(dir);
        }
      }
    }
  }

  private nextMtime(): number {
    return ++this.mtimeCounter;
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = path.replace(/\/$/, '') || '/';
    const entries = new Set<string>();

    for (const filePath of this.files.keys()) {
      const parent = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
      if (parent === normalized) {
        entries.add(filePath.split('/').pop()!);
      }
    }

    for (const dir of this.dirs) {
      if (dir === normalized) continue;
      const parent = dir.substring(0, dir.lastIndexOf('/')) || '/';
      if (parent === normalized) {
        entries.add(dir.split('/').pop()!);
      }
    }

    return Array.from(entries);
  }

  async readFile(path: string, _encoding?: BufferEncoding): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file.content;
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const content = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.files.set(path, { content, mtimeMs: this.nextMtime() });
    // 自动创建父目录
    const parts = path.split('/').filter(Boolean);
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dir += `/${parts[i]}`;
      this.dirs.add(dir);
    }
  }

  async unlink(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
    this.files.delete(path);
  }

  async stat(path: string): Promise<FileStat> {
    const file = this.files.get(path);
    if (file) {
      return {
        mode: 0o100644,
        size: file.content.length,
        mtimeMs: file.mtimeMs,
      };
    }
    if (this.dirs.has(path)) {
      return {
        mode: 0o040755,
        size: 0,
        mtimeMs: 0,
      };
    }
    throw new Error(`ENOENT: ${path}`);
  }

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async createSnapshot(root: string, _filter?: SyncFilter): Promise<Map<string, FileSnapshot> | null> {
    this.createSnapshotCalls++;
    const normalizedRoot = root.replace(/\/$/, '') || '/';
    const snapshot = new Map<string, FileSnapshot>();

    for (const [filePath, file] of this.files) {
      // Compute relative path from root
      let relPath: string;
      if (normalizedRoot === '/') {
        relPath = filePath;
      } else if (filePath.startsWith(normalizedRoot + '/')) {
        relPath = filePath.slice(normalizedRoot.length);
      } else {
        continue; // Not under root
      }
      if (!relPath.startsWith('/')) relPath = '/' + relPath;

      snapshot.set(relPath, {
        path: relPath,
        size: file.content.length,
        mtimeMs: file.mtimeMs,
      });
    }

    return snapshot;
  }

  // --- 测试辅助方法 ---

  /** 获取文件内容 */
  getContent(path: string): string | undefined {
    return this.files.get(path)?.content;
  }

  /** 直接设置文件内容（不更新 mtime，用于模拟无变更） */
  setContentRaw(path: string, content: string): void {
    const existing = this.files.get(path);
    if (existing) {
      existing.content = content;
    } else {
      this.files.set(path, { content, mtimeMs: this.nextMtime() });
    }
  }

  /** 获取所有文件路径 */
  listFiles(): string[] {
    return Array.from(this.files.keys());
  }

  /** 设置文件 mtime（测试用） */
  setMtime(path: string, mtimeMs: number): void {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    file.mtimeMs = mtimeMs;
  }

  /** 获取文件 mtime（测试用） */
  getMtime(path: string): number {
    return this.files.get(path)?.mtimeMs ?? 0;
  }
}