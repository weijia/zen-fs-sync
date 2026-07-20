"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  ChangeType: () => ChangeType,
  ConflictStrategy: () => ConflictStrategy,
  DefaultConflictResolver: () => DefaultConflictResolver,
  FullDetector: () => FullDetector,
  IncrementalDetector: () => IncrementalDetector,
  SyncDirection: () => SyncDirection,
  SyncPair: () => SyncPair,
  SyncPairState: () => SyncPairState,
  ZenFSSync: () => ZenFSSync,
  createLogger: () => createLogger,
  isDebugEnabled: () => isDebugEnabled,
  setDebug: () => setDebug
});
module.exports = __toCommonJS(index_exports);

// src/types.ts
var ChangeType = /* @__PURE__ */ ((ChangeType2) => {
  ChangeType2["Created"] = "created";
  ChangeType2["Modified"] = "modified";
  ChangeType2["Deleted"] = "deleted";
  return ChangeType2;
})(ChangeType || {});
var ConflictStrategy = /* @__PURE__ */ ((ConflictStrategy2) => {
  ConflictStrategy2["SourceWins"] = "source-wins";
  ConflictStrategy2["TargetWins"] = "target-wins";
  ConflictStrategy2["Merge"] = "merge";
  return ConflictStrategy2;
})(ConflictStrategy || {});
var SyncDirection = /* @__PURE__ */ ((SyncDirection2) => {
  SyncDirection2["OneWay"] = "one-way";
  SyncDirection2["BiDirectional"] = "bi-directional";
  return SyncDirection2;
})(SyncDirection || {});
var SyncPairState = /* @__PURE__ */ ((SyncPairState3) => {
  SyncPairState3["Idle"] = "idle";
  SyncPairState3["Syncing"] = "syncing";
  SyncPairState3["Watching"] = "watching";
  SyncPairState3["Paused"] = "paused";
  SyncPairState3["Disposed"] = "disposed";
  return SyncPairState3;
})(SyncPairState || {});

// src/logger.ts
var enabled = false;
var tagFilter = /* @__PURE__ */ new Set();
function setDebug(value) {
  if (typeof value === "string") {
    enabled = true;
    tagFilter.clear();
    for (const tag of value.split(",").map((s) => s.trim()).filter(Boolean)) {
      tagFilter.add(tag);
    }
  } else {
    enabled = value;
    tagFilter.clear();
  }
}
function isDebugEnabled() {
  return enabled;
}
function createLogger(tag) {
  return (...args) => {
    if (!enabled) return;
    if (tagFilter.size > 0 && !tagFilter.has(tag)) return;
    console.log(`[zen-fs-sync:${tag}]`, ...args);
  };
}

// src/utils.ts
var log = createLogger("detector");
function normalizePath(p) {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1 && s.endsWith("/")) {
    s = s.slice(0, -1);
  }
  return s;
}
function resolvePath(root, relative) {
  const r = normalizePath(root);
  const rel = relative.startsWith("/") ? relative.slice(1) : relative;
  if (!rel) return r;
  const joined = r === "/" ? `/${rel}` : `${r}/${rel}`;
  return normalizePath(joined);
}
function isPathAllowed(path, filter) {
  if (!filter) return true;
  const normalized = normalizePath(path);
  if (filter.excludePrefixes?.length) {
    for (const prefix of filter.excludePrefixes) {
      if (normalized.startsWith(normalizePath(prefix))) return false;
    }
  }
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
  if (filter.includeGlobs?.length) {
    const fileName = normalized.split("/").pop();
    const globMatched = filter.includeGlobs.some(
      (g) => simpleGlobMatch(fileName, g)
    );
    if (!globMatched) return false;
  }
  return true;
}
function simpleGlobMatch(str, pattern) {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(str);
}
async function walkFiles(fs, root, filter) {
  const results = [];
  const normalizedRoot = normalizePath(root);
  async function visit(dir) {
    console.log(`[zen-fs-sync] walkFiles readdir: ${dir}`);
    let entries;
    try {
      entries = await fs.readdir(dir);
      console.log(`[zen-fs-sync] walkFiles readdir: ${dir} \u2192 ${entries.length} entries: [${entries.join(", ")}]`);
    } catch (err) {
      console.warn(`[zen-fs-sync] walkFiles readdir FAILED on ${dir}:`, err.message || err);
      return;
    }
    for (const entry of entries) {
      if (entry === ".zenfs-sync") continue;
      const fullPath = resolvePath(dir, entry);
      let relPath = fullPath.slice(normalizedRoot.length) || "/";
      if (!relPath.startsWith("/")) relPath = "/" + relPath;
      console.log(`[zen-fs-sync] walkFiles stat: ${fullPath}`);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (err) {
        console.warn(`[zen-fs-sync] walkFiles stat FAILED on ${fullPath}:`, err.message || err);
        continue;
      }
      if (stat.isDirectory()) {
        console.log(`[zen-fs-sync] walkFiles   \u2192 directory ${fullPath}`);
        await visit(fullPath);
      } else if (stat.isFile()) {
        console.log(`[zen-fs-sync] walkFiles   \u2192 file ${fullPath}`);
        if (!isPathAllowed(relPath, filter)) {
          console.log(`[zen-fs-sync] walkFiles   \u2192 excluded by filter: ${relPath}`);
          continue;
        }
        results.push(relPath);
      } else {
        console.log(`[zen-fs-sync] walkFiles   \u2192 unknown type ${fullPath}`);
      }
    }
  }
  await visit(normalizedRoot);
  console.log(`[zen-fs-sync] walkFiles(${root}) total: ${results.length} files: [${results.join(", ")}]`);
  return results;
}
async function buildSnapshot(fs, root, filter) {
  const normalizedRoot = normalizePath(root);
  console.log(`[zen-fs-sync] buildSnapshot: root=${root}, normalizedRoot=${normalizedRoot}`);
  try {
    const rootEntries = await fs.readdir(normalizedRoot);
    console.log(`[zen-fs-sync] buildSnapshot: readdir(${normalizedRoot}) \u2192 ${rootEntries.length} entries: [${rootEntries.join(", ")}]`);
    for (const entry of rootEntries) {
      const fullPath = resolvePath(normalizedRoot, entry);
      try {
        const stat = await fs.stat(fullPath);
        const type = stat.isDirectory() ? "DIR" : stat.isFile() ? "FILE" : "OTHER";
        console.log(`[zen-fs-sync] buildSnapshot:   ${type} ${entry} (fullPath=${fullPath})`);
        if (stat.isDirectory()) {
          try {
            const subEntries = await fs.readdir(fullPath);
            console.log(`[zen-fs-sync] buildSnapshot:     readdir(${fullPath}) \u2192 [${subEntries.join(", ")}]`);
          } catch (err) {
            console.warn(`[zen-fs-sync] buildSnapshot:     readdir(${fullPath}) FAILED:`, err.message || err);
          }
        }
      } catch (err) {
        console.warn(`[zen-fs-sync] buildSnapshot:   stat(${fullPath}) FAILED:`, err.message || err);
      }
    }
  } catch (err) {
    console.warn(`[zen-fs-sync] buildSnapshot: readdir(${normalizedRoot}) FAILED:`, err.message || err);
  }
  const files = await walkFiles(fs, root, filter);
  console.log(`[zen-fs-sync] buildSnapshot: walkFiles returned ${files.length} files: [${files.join(", ")}]`);
  const snapshot = /* @__PURE__ */ new Map();
  for (const relPath of files) {
    const fullPath = resolvePath(normalizedRoot, relPath);
    try {
      const stat = await fs.stat(fullPath);
      snapshot.set(relPath, {
        path: relPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs
      });
    } catch {
    }
  }
  log(`buildSnapshot: done, ${snapshot.size} entries`);
  return snapshot;
}
async function ensureDir(fs, dirPath) {
  const normalized = normalizePath(dirPath);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    const exists = await fs.exists(current);
    if (!exists) {
      await fs.mkdir(current, { recursive: true });
    }
  }
}
var counter = 0;
function generatePairId() {
  counter++;
  return `sync-${Date.now().toString(36)}-${counter.toString(36)}`;
}
function deepMergeJSON(target, source) {
  if (source === void 0 || source === null) return target;
  if (target === void 0 || target === null) return source;
  if (typeof source !== "object" || typeof target !== "object") return source;
  if (Array.isArray(source) || Array.isArray(target)) return source;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    result[key] = deepMergeJSON(tv, sv);
  }
  return result;
}
function tryParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function isJsonPath(path) {
  return path.endsWith(".json");
}
function diffSnapshots(source, target) {
  const changes = [];
  for (const [path, snap] of source) {
    if (!target.has(path)) {
      changes.push({ path, type: "created" /* Created */, sourceSnapshot: snap });
    } else {
      const targetSnap = target.get(path);
      if (snap.mtimeMs !== targetSnap.mtimeMs || snap.size !== targetSnap.size) {
        changes.push({
          path,
          type: "modified" /* Modified */,
          sourceSnapshot: snap,
          targetSnapshot: targetSnap
        });
      }
    }
  }
  for (const [path, snap] of target) {
    if (!source.has(path)) {
      changes.push({ path, type: "deleted" /* Deleted */, targetSnapshot: snap });
    }
  }
  return changes;
}

// src/detector/incremental.ts
var log2 = createLogger("detector");
var IncrementalDetector = class {
  async detect(source, target, root, prevSnapshots, filter) {
    if (!prevSnapshots || prevSnapshots.size === 0) {
      log2(`[FULL] no prevSnapshots, scanning source + target (root=${root})`);
      const currentSnap = await buildSnapshot(source, root, filter);
      const targetSnap = await buildSnapshot(target, root, filter);
      log2(`[FULL] source files: ${currentSnap.size}, target files: ${targetSnap.size}`);
      const changes2 = diffSnapshots(currentSnap, targetSnap);
      log2(`[FULL] detected ${changes2.length} changes:`, changes2.map((c) => `${c.type}:${c.path}`));
      return changes2;
    }
    log2(`[INCREMENTAL] scanning source vs prevSnapshots (${prevSnapshots.size} entries, root=${root})`);
    const currentSourceSnap = await buildSnapshot(source, root, filter);
    log2(`[INCREMENTAL] current source files: ${currentSourceSnap.size}`);
    const changes = diffSnapshots(currentSourceSnap, prevSnapshots);
    log2(`[INCREMENTAL] detected ${changes.length} changes:`, changes.map((c) => `${c.type}:${c.path}`));
    return changes;
  }
};

// src/strategy/default.ts
var DefaultConflictResolver = class {
  async resolve(path, sourceContent, targetContent, strategy) {
    switch (strategy) {
      case "source-wins" /* SourceWins */:
        return { content: sourceContent, strategy };
      case "target-wins" /* TargetWins */:
        return { content: targetContent, strategy };
      case "merge" /* Merge */: {
        if (!isJsonPath(path)) {
          return { content: sourceContent, strategy: "source-wins" /* SourceWins */ };
        }
        const sourceJSON = tryParseJSON(sourceContent);
        const targetJSON = tryParseJSON(targetContent);
        if (sourceJSON === void 0 || targetJSON === void 0) {
          return { content: sourceContent, strategy: "source-wins" /* SourceWins */ };
        }
        const merged = deepMergeJSON(targetJSON, sourceJSON);
        return {
          content: JSON.stringify(merged, null, 2),
          strategy
        };
      }
      default:
        return { content: sourceContent, strategy: "source-wins" /* SourceWins */ };
    }
  }
};

// src/sync-pair.ts
var log3 = createLogger("sync");
var SyncPair = class {
  constructor(source, target, options = {}, syncRoot = "/") {
    this.syncRoot = syncRoot;
    this.pairId = generatePairId();
    this.source = source;
    this.target = target;
    this.root = normalizePath(syncRoot);
    this.options = {
      direction: options.direction ?? "one-way" /* OneWay */,
      conflictStrategy: options.conflictStrategy ?? "source-wins" /* SourceWins */,
      debounceMs: options.debounceMs ?? 300,
      filter: options.filter
    };
    this.detector = new IncrementalDetector();
    this.resolver = new DefaultConflictResolver();
    log3(`pair ${this.pairId} created: root=${this.root} dir=${this.options.direction}`);
  }
  syncRoot;
  pairId;
  source;
  target;
  root;
  options;
  detector;
  resolver;
  state = "idle" /* Idle */;
  lastResult;
  totalSyncs = 0;
  watchers;
  debounceTimer;
  listeners = /* @__PURE__ */ new Map();
  sourceSnapshots;
  // -----------------------------------------------------------------------
  // 手动同步
  // -----------------------------------------------------------------------
  /**
   * 执行一次同步。
   */
  async sync() {
    if (this.state === "disposed" /* Disposed */) {
      throw new Error(`SyncPair ${this.pairId} has been disposed`);
    }
    if (this.state === "syncing" /* Syncing */) {
      throw new Error(`SyncPair ${this.pairId} is already syncing`);
    }
    const startTime = Date.now();
    this.state = "syncing" /* Syncing */;
    this.emit({ type: "sync:start", pairId: this.pairId, timestamp: Date.now() });
    try {
      let result;
      if (this.options.direction === "bi-directional" /* BiDirectional */) {
        result = await this.syncBidirectional();
      } else {
        result = await this.syncOneWay(this.source, this.target, "source\u2192target");
      }
      result.durationMs = Date.now() - startTime;
      this.lastResult = result;
      this.totalSyncs++;
      this.state = this.watchers ? "watching" /* Watching */ : "idle" /* Idle */;
      log3(`sync:end ${this.pairId} +${result.filesCreated}/~${result.filesUpdated}/-${result.filesDeleted} skip:${result.filesSkipped} changes:${result.changes.length} ${result.durationMs}ms`);
      this.emit({
        type: "sync:end",
        pairId: this.pairId,
        timestamp: Date.now(),
        result
      });
      return result;
    } catch (error) {
      this.state = this.watchers ? "watching" /* Watching */ : "idle" /* Idle */;
      log3(`sync:error ${this.pairId}`, error);
      this.emit({
        type: "sync:error",
        pairId: this.pairId,
        timestamp: Date.now(),
        error: error instanceof Error ? error : new Error(String(error))
      });
      throw error;
    }
  }
  // -----------------------------------------------------------------------
  // Watch 模式
  // -----------------------------------------------------------------------
  /**
   * 启动自动监听同步。
   * 使用轮询检测变更，防抖触发同步。
   */
  watch() {
    if (this.state === "disposed" /* Disposed */) {
      throw new Error(`SyncPair ${this.pairId} has been disposed`);
    }
    if (this.watchers) return;
    this.state = "watching" /* Watching */;
    log3(`watch:start ${this.pairId} (building initial snapshots...)`);
    this.emit({ type: "watch:start", pairId: this.pairId, timestamp: Date.now() });
    this.buildInitialSnapshots().then(() => {
      const intervalMs = Math.max(this.options.debounceMs, 500);
      this.watchers = {
        source: setInterval(() => this.onPoll(), intervalMs),
        target: this.options.direction === "bi-directional" /* BiDirectional */ ? setInterval(() => this.onPoll(), intervalMs) : null
      };
      log3(`watch:start ${this.pairId} interval=${intervalMs}ms (snapshots ready)`);
    }).catch((err) => {
      log3(`watch:init-snapshots failed ${this.pairId}`, err);
      const intervalMs = Math.max(this.options.debounceMs, 500);
      this.watchers = {
        source: setInterval(() => this.onPoll(), intervalMs),
        target: null
      };
    });
  }
  /**
   * 停止自动监听。
   */
  unwatch() {
    if (!this.watchers) return;
    clearInterval(this.watchers.source);
    if (this.watchers.target) {
      clearInterval(this.watchers.target);
    }
    this.watchers = void 0;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = void 0;
    }
    this.state = "idle" /* Idle */;
    log3(`watch:stop ${this.pairId}`);
    this.emit({ type: "watch:stop", pairId: this.pairId, timestamp: Date.now() });
  }
  // -----------------------------------------------------------------------
  // 状态查询
  // -----------------------------------------------------------------------
  getStatus() {
    return {
      pairId: this.pairId,
      state: this.state,
      lastResult: this.lastResult,
      watching: !!this.watchers,
      totalSyncs: this.totalSyncs
    };
  }
  // -----------------------------------------------------------------------
  // 生命周期
  // -----------------------------------------------------------------------
  /**
   * 销毁同步对，停止 watch 并释放资源。
   */
  dispose() {
    this.unwatch();
    this.state = "disposed" /* Disposed */;
    this.listeners.clear();
    this.sourceSnapshots = void 0;
    log3(`disposed ${this.pairId}`);
  }
  // -----------------------------------------------------------------------
  // 事件
  // -----------------------------------------------------------------------
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, /* @__PURE__ */ new Set());
    }
    this.listeners.get(event).add(handler);
  }
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }
  emit(event) {
    const handlers = this.listeners.get(event.type);
    if (handlers) {
      for (const h of handlers) {
        try {
          h(event);
        } catch {
        }
      }
    }
  }
  // -----------------------------------------------------------------------
  // 内部实现
  // -----------------------------------------------------------------------
  async syncOneWay(src, tgt, directionLabel) {
    const changes = await this.detector.detect(
      src,
      tgt,
      this.root,
      this.sourceSnapshots,
      this.options.filter
    );
    this.sourceSnapshots = await buildSnapshot(src, this.root, this.options.filter);
    let filesCreated = 0;
    let filesUpdated = 0;
    let filesDeleted = 0;
    let filesSkipped = 0;
    const conflicts = [];
    for (const change of changes) {
      const srcPath = resolvePath(this.root, change.path);
      const tgtPath = resolvePath(this.root, change.path);
      switch (change.type) {
        case "created" /* Created */:
        case "modified" /* Modified */: {
          const isCreated = change.type === "created" /* Created */;
          if (change.type === "modified" /* Modified */) {
            const srcContent = await src.readFile(srcPath, "utf-8");
            const tgtContent = await tgt.readFile(tgtPath, "utf-8");
            if (srcContent !== tgtContent) {
              const resolved = await this.resolver.resolve(
                change.path,
                srcContent,
                tgtContent,
                this.options.conflictStrategy
              );
              const conflict = {
                path: change.path,
                sourceContent: srcContent,
                targetContent: tgtContent,
                resolvedWith: resolved.strategy,
                mergedContent: resolved.strategy === "merge" /* Merge */ ? resolved.content : void 0
              };
              conflicts.push(conflict);
              this.emit({
                type: "conflict",
                pairId: this.pairId,
                timestamp: Date.now(),
                conflict
              });
              if (isCreated) filesCreated++;
              else filesUpdated++;
              await ensureDir(tgt, tgtPath.substring(0, tgtPath.lastIndexOf("/")));
              await tgt.writeFile(tgtPath, resolved.content);
              continue;
            }
          }
          try {
            const content = await src.readFile(srcPath, "utf-8");
            log3(`WRITE ${change.type} ${srcPath} \u2192 ${tgtPath} (${content.length} bytes)`);
            await ensureDir(tgt, tgtPath.substring(0, tgtPath.lastIndexOf("/")));
            await tgt.writeFile(tgtPath, content);
            if (isCreated) filesCreated++;
            else filesUpdated++;
          } catch (err) {
            log3(`WRITE FAIL ${change.type} ${srcPath} \u2192 ${tgtPath}:`, err);
            filesSkipped++;
          }
          break;
        }
        case "deleted" /* Deleted */: {
          try {
            log3(`DELETE ${tgtPath}`);
            await tgt.unlink(tgtPath);
            filesDeleted++;
          } catch (err) {
            log3(`DELETE FAIL ${tgtPath}:`, err);
            filesSkipped++;
          }
          break;
        }
      }
    }
    return {
      pairId: this.pairId,
      direction: this.options.direction,
      timestamp: Date.now(),
      filesCreated,
      filesUpdated,
      filesDeleted,
      filesSkipped,
      conflicts,
      changes,
      durationMs: 0
      // 由 sync() 方法填充
    };
  }
  async syncBidirectional() {
    if (!this.sourceSnapshots || this.sourceSnapshots.size === 0) {
      log3(`[BI] first sync \u2014 pulling target \u2192 source first`);
      const pull = await this.syncOneWay(this.target, this.source, "init:target\u2192source");
      if (pull.filesCreated > 0 || pull.filesUpdated > 0) {
        log3(`[BI] initial pull complete: +${pull.filesCreated} ~${pull.filesUpdated}`);
      }
    }
    const forward = await this.syncOneWay(this.source, this.target, "source\u2192target");
    const reverse = await this.syncOneWay(this.target, this.source, "target\u2192source");
    return {
      pairId: this.pairId,
      direction: "bi-directional" /* BiDirectional */,
      timestamp: Date.now(),
      filesCreated: forward.filesCreated + reverse.filesCreated,
      filesUpdated: forward.filesUpdated + reverse.filesUpdated,
      filesDeleted: forward.filesDeleted + reverse.filesDeleted,
      filesSkipped: forward.filesSkipped + reverse.filesSkipped,
      conflicts: [...forward.conflicts, ...reverse.conflicts],
      changes: [...forward.changes, ...reverse.changes],
      durationMs: 0
    };
  }
  async onPoll() {
    if (this.state === "syncing" /* Syncing */) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = void 0;
      this.sync().catch(() => {
      });
    }, this.options.debounceMs);
  }
  async buildInitialSnapshots() {
    if (this.options.direction === "bi-directional" /* BiDirectional */) {
      const [srcSnap, tgtSnap] = await Promise.all([
        buildSnapshot(this.source, this.root, this.options.filter),
        buildSnapshot(this.target, this.root, this.options.filter)
      ]);
      this.sourceSnapshots = new Map([...srcSnap, ...tgtSnap]);
      log3(`initial snapshots: source=${srcSnap.size}, target=${tgtSnap.size}`);
    } else {
      this.sourceSnapshots = await buildSnapshot(
        this.source,
        this.root,
        this.options.filter
      );
      log3(`initial snapshots: source=${this.sourceSnapshots.size}`);
    }
  }
};

// src/zen-fs-sync.ts
var ZenFSSync = class {
  pairs = /* @__PURE__ */ new Map();
  // -----------------------------------------------------------------------
  // 创建同步对
  // -----------------------------------------------------------------------
  /**
   * 创建一个同步对并注册到管理器。
   *
   * @param source  源文件系统（满足 SyncableFS 接口）
   * @param target  目标文件系统
   * @param options 同步选项
   * @param root    同步根路径，默认 '/'
   * @returns SyncPair 实例
   */
  addPair(source, target, options, root) {
    const pair = new SyncPair(source, target, options, root);
    this.pairs.set(pair.pairId, pair);
    return pair;
  }
  // -----------------------------------------------------------------------
  // 同步操作
  // -----------------------------------------------------------------------
  /**
   * 手动触发指定同步对的一次同步。
   */
  async sync(pairId) {
    const pair = this.getPair(pairId);
    return pair.sync();
  }
  /**
   * 同步所有已注册的对。
   * 并行执行，返回所有结果。
   */
  async syncAll() {
    const results = /* @__PURE__ */ new Map();
    const entries = Array.from(this.pairs.entries());
    await Promise.all(
      entries.map(async ([id, pair]) => {
        try {
          results.set(id, await pair.sync());
        } catch (error) {
          results.set(id, {
            pairId: id,
            direction: pair.getStatus().lastResult?.direction ?? "one-way" /* OneWay */,
            timestamp: Date.now(),
            filesCreated: 0,
            filesUpdated: 0,
            filesDeleted: 0,
            filesSkipped: 0,
            conflicts: [],
            changes: [],
            durationMs: 0
          });
        }
      })
    );
    return results;
  }
  // -----------------------------------------------------------------------
  // Watch 操作
  // -----------------------------------------------------------------------
  /**
   * 启动指定同步对的自动监听。
   */
  watch(pairId) {
    this.getPair(pairId).watch();
  }
  /**
   * 停止指定同步对的自动监听。
   */
  unwatch(pairId) {
    this.getPair(pairId).unwatch();
  }
  /**
   * 启动所有同步对的自动监听。
   */
  watchAll() {
    for (const pair of this.pairs.values()) {
      pair.watch();
    }
  }
  /**
   * 停止所有同步对的自动监听。
   */
  unwatchAll() {
    for (const pair of this.pairs.values()) {
      pair.unwatch();
    }
  }
  // -----------------------------------------------------------------------
  // 查询
  // -----------------------------------------------------------------------
  /**
   * 获取指定同步对的状态。
   */
  getStatus(pairId) {
    return this.getPair(pairId).getStatus();
  }
  /**
   * 获取所有同步对的状态。
   */
  getStatusAll() {
    const statuses = /* @__PURE__ */ new Map();
    for (const [id, pair] of this.pairs) {
      statuses.set(id, pair.getStatus());
    }
    return statuses;
  }
  /**
   * 列出所有已注册的 pairId。
   */
  listPairs() {
    return Array.from(this.pairs.keys());
  }
  // -----------------------------------------------------------------------
  // 事件
  // -----------------------------------------------------------------------
  /**
   * 为指定同步对注册事件监听。
   */
  on(pairId, event, handler) {
    this.getPair(pairId).on(event, handler);
  }
  /**
   * 移除指定同步对的事件监听。
   */
  off(pairId, event, handler) {
    this.getPair(pairId).off(event, handler);
  }
  // -----------------------------------------------------------------------
  // 生命周期
  // -----------------------------------------------------------------------
  /**
   * 移除并销毁指定同步对。
   */
  removePair(pairId) {
    const pair = this.pairs.get(pairId);
    if (pair) {
      pair.dispose();
      this.pairs.delete(pairId);
    }
  }
  /**
   * 销毁管理器及所有同步对。
   */
  dispose() {
    for (const pair of this.pairs.values()) {
      pair.dispose();
    }
    this.pairs.clear();
  }
  // -----------------------------------------------------------------------
  // 内部
  // -----------------------------------------------------------------------
  getPair(pairId) {
    const pair = this.pairs.get(pairId);
    if (!pair) {
      throw new Error(`SyncPair not found: ${pairId}`);
    }
    return pair;
  }
};

// src/detector/full.ts
var FullDetector = class {
  async detect(source, target, root, prevSnapshots, filter) {
    const [sourceSnap, targetSnap] = await Promise.all([
      buildSnapshot(source, root, filter),
      buildSnapshot(target, root, filter)
    ]);
    return diffSnapshots(sourceSnap, targetSnap);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ChangeType,
  ConflictStrategy,
  DefaultConflictResolver,
  FullDetector,
  IncrementalDetector,
  SyncDirection,
  SyncPair,
  SyncPairState,
  ZenFSSync,
  createLogger,
  isDebugEnabled,
  setDebug
});
