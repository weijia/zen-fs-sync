/**
 * zen-fs-sync — Debug Logger (powered by @richard432/localstorage-logger)
 *
 * 每个模块对应一个 localStorage key `debug:zen-fs-sync:<tag>`。
 * key 不存在时自动创建并设为 '1'（默认开启）。
 * 在浏览器控制台中控制：
 *   localStorage.setItem('debug:zen-fs-sync:sync', '0')  // 关闭
 *   localStorage.setItem('debug:zen-fs-sync:sync', '1')  // 开启
 */

import {
  createLogger as createLoggerBase,
  setDebugEnabled,
  isDebugEnabled as isBaseEnabled,
} from '@richard432/localstorage-logger';

const MODULE_PREFIX = 'zen-fs-sync';

/**
 * Create a logger for the given tag.
 * Returns a single-argument function (backward compatible with existing callers).
 */
export function createLogger(tag: string): (...args: unknown[]) => void {
  const logger = createLoggerBase(`${MODULE_PREFIX}:${tag}`);
  return (...args: unknown[]) => logger.log(...args);
}

/**
 * Enable/disable debug logging.
 * @param value - `true` to enable all, `false` to disable all,
 *                or a comma-separated string of tag names to enable.
 */
export function setDebug(value: boolean | string): void {
  if (typeof value === 'string') {
    // Enable only the specified tags
    const tags = value.split(',').map(s => s.trim()).filter(Boolean);
    for (const tag of tags) {
      setDebugEnabled(`${MODULE_PREFIX}:${tag}`, true);
    }
  } else {
    // Enable/disable all known zen-fs-sync modules
    setDebugEnabled(`${MODULE_PREFIX}:sync`, value);
    setDebugEnabled(`${MODULE_PREFIX}:detector`, value);
    setDebugEnabled(`${MODULE_PREFIX}:strategy`, value);
  }
}

/**
 * Check if debug logging is enabled for the sync module.
 */
export function isDebugEnabled(): boolean {
  return isBaseEnabled(`${MODULE_PREFIX}:sync`);
}
