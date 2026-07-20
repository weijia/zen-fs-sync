/**
 * zen-fs-sync — Debug Logger
 *
 * 轻量级调试日志系统，支持全局开关和标签过滤。
 *
 * 使用方式：
 *   import { createLogger } from './logger';
 *   const log = createLogger('sync');
 *   log('file list:', files);           // [zen-fs-sync:sync] file list: [...]
 *
 * 开启调试（在调用 createConfigRepo 之前设置）：
 *   import { setDebug } from 'zen-fs-sync/logger';
 *   setDebug(true);                        // 开启全部
 *   setDebug('sync,detector');             // 只开 sync 和 detector 标签
 */

let enabled = false;
const tagFilter = new Set<string>();

export function setDebug(value: boolean | string): void {
  if (typeof value === 'string') {
    enabled = true;
    tagFilter.clear();
    for (const tag of value.split(',').map(s => s.trim()).filter(Boolean)) {
      tagFilter.add(tag);
    }
  } else {
    enabled = value;
    tagFilter.clear();
  }
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function createLogger(tag: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (!enabled) return;
    if (tagFilter.size > 0 && !tagFilter.has(tag)) return;
    console.log(`[zen-fs-sync:${tag}]`, ...args);
  };
}
