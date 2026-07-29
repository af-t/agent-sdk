import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../support/errors.js';
import { resolveLogger } from '../support/logger.js';

export function createFileWatchSource(options = {}) {
  const {
    paths,
    recursive = false,
    usePolling = false,
    pollIntervalMs = 1000,
    debounceMs = 50,
    coalesce = false,
    ignore = [],
    filter,
    type = 'file-change',
    _backend = defaultBackend,
    logger,
  } = options;
  const componentLogger = resolveLogger(logger).child({ component: 'fileWatchSource' });

  const list = paths == null ? [] : Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) {
    throw new ConfigError('createFileWatchSource requires paths to be a string or non-empty array');
  }
  for (const p of list) {
    if (typeof p !== 'string') throw new ConfigError('Every createFileWatchSource path must be a string');
  }
  if (!(typeof debounceMs === 'number' && debounceMs > 0)) {
    throw new ConfigError('createFileWatchSource requires debounceMs to be a positive number');
  }
  if (!(typeof pollIntervalMs === 'number' && pollIntervalMs > 0)) {
    throw new ConfigError('createFileWatchSource requires pollIntervalMs to be a positive number');
  }
  if (filter != null && typeof filter !== 'function') {
    throw new ConfigError('createFileWatchSource requires filter to be a function');
  }
  if (!Array.isArray(ignore)) {
    throw new ConfigError('createFileWatchSource requires ignore to be an array of strings');
  }

  const absPaths = list.map((p) => path.resolve(p));

  let emitFn = null;
  let stopBackend = null;
  let started = false;

  const perPathTimers = new Map(); // path -> { timer, eventType }
  const coalesceMap = new Map(); // path -> eventType
  let coalesceTimer = null;

  function mergeEventType(prev, next) {
    return prev === 'rename' || next === 'rename' ? 'rename' : next;
  }

  function safeEmit(event) {
    if (!emitFn) return;
    try {
      emitFn(event);
    } catch (err) {
      componentLogger.warn(
        { error: err, eventType: event?.type },
        'File watch callback failed while emitting an event',
      );
    }
  }

  function emitPerPath(absPath, eventType) {
    const existing = perPathTimers.get(absPath);
    const merged = existing ? mergeEventType(existing.eventType, eventType) : eventType;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      perPathTimers.delete(absPath);
      safeEmit({ type, path: absPath, eventType: merged });
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
    perPathTimers.set(absPath, { timer, eventType: merged });
  }

  function emitCoalesced(absPath, eventType) {
    const prev = coalesceMap.get(absPath);
    coalesceMap.set(absPath, prev ? mergeEventType(prev, eventType) : eventType);
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      const changes = [...coalesceMap.entries()].map(([p, e]) => ({ path: p, eventType: e }));
      coalesceMap.clear();
      coalesceTimer = null;
      safeEmit({ type, paths: changes.map((c) => c.path), changes });
    }, debounceMs);
    if (typeof coalesceTimer.unref === 'function') coalesceTimer.unref();
  }

  function passesFilters(absPath, eventType) {
    for (const sub of ignore) {
      if (typeof sub === 'string' && absPath.includes(sub)) return false;
    }
    if (filter && !filter(absPath, eventType)) return false;
    return true;
  }

  function onRaw(absPath, eventType) {
    if (!passesFilters(absPath, eventType)) return;
    if (coalesce) emitCoalesced(absPath, eventType);
    else emitPerPath(absPath, eventType);
  }

  return {
    start(emit) {
      if (started) {
        componentLogger.warn({}, 'File watch source ignored a duplicate start');
        return;
      }
      started = true;
      emitFn = emit;
      try {
        stopBackend = _backend({ paths: absPaths, recursive, usePolling, pollIntervalMs }, onRaw, componentLogger);
      } catch (err) {
        componentLogger.warn({ error: err }, 'File watch backend failed to start');
      }
    },
    stop() {
      started = false;
      if (typeof stopBackend === 'function') {
        try {
          stopBackend();
        } catch (err) {
          componentLogger.warn({ error: err }, 'File watch backend failed to stop');
        }
      }
      stopBackend = null;
      for (const { timer } of perPathTimers.values()) clearTimeout(timer);
      perPathTimers.clear();
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      coalesceMap.clear();
      emitFn = null;
    },
  };
}

function defaultBackend({ paths, recursive, usePolling, pollIntervalMs }, onRaw, logger) {
  if (usePolling) return startPolling({ paths, recursive, pollIntervalMs }, onRaw, logger);
  return startNativeWatch({ paths, recursive }, onRaw, logger);
}

function startNativeWatch({ paths, recursive }, onRaw, logger) {
  const watchers = [];
  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (err) {
      logger.warn({ error: err, path: p }, 'Cannot watch path');
      continue;
    }
    const isDir = stat.isDirectory();
    try {
      const watcher = fs.watch(p, { recursive: isDir && recursive, persistent: false }, (eventType, filename) => {
        const abs = isDir && filename ? path.resolve(p, filename) : p;
        onRaw(abs, eventType === 'rename' ? 'rename' : 'change');
      });
      watcher.on('error', (err) => logger.warn({ error: err, path: p }, 'Watcher emitted an error event'));
      watchers.push(watcher);
    } catch (err) {
      logger.warn({ error: err, path: p }, 'fs.watch failed');
    }
  }
  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Continue closing the remaining watchers.
      }
    }
  };
}

function startPolling({ paths, recursive, pollIntervalMs }, onRaw, logger) {
  const watched = new Set();
  const watchedDirs = new Set();
  function watchOne(file) {
    if (watched.has(file)) return;
    watched.add(file);
    fs.watchFile(file, { interval: pollIntervalMs, persistent: false }, (curr, prev) => {
      const existed = prev.mtimeMs !== 0;
      const exists = curr.mtimeMs !== 0;
      onRaw(file, existed !== exists ? 'rename' : 'change');
      // Rescanning restores a watcher if a deleted file is created again.
      if (!exists) {
        fs.unwatchFile(file);
        watched.delete(file);
      }
    });
  }
  function expand(p) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch (err) {
      logger.warn({ error: err, path: p }, 'Cannot poll path');
      return;
    }
    if (!stat.isDirectory()) {
      watchOne(p);
      return;
    }
    watchedDirs.add(p);
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (err) {
      logger.warn({ error: err, path: p }, 'Cannot read directory');
      return;
    }
    for (const entry of entries) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) {
        if (recursive) expand(child);
      } else {
        watchOne(child);
      }
    }
  }
  // fs.watchFile cannot see later directory entries. A periodic scan adds them
  // and reports their arrival as rename, matching fs.watch.
  function rescan() {
    for (const dir of [...watchedDirs]) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (recursive && !watchedDirs.has(child)) {
            expand(child);
            onRaw(child, 'rename');
          }
        } else if (!watched.has(child)) {
          watchOne(child);
          onRaw(child, 'rename');
        }
      }
    }
  }
  for (const p of paths) expand(p);
  const rescanTimer = setInterval(rescan, pollIntervalMs);
  if (typeof rescanTimer.unref === 'function') rescanTimer.unref();
  return () => {
    clearInterval(rescanTimer);
    for (const file of watched) fs.unwatchFile(file);
    watched.clear();
    watchedDirs.clear();
  };
}
