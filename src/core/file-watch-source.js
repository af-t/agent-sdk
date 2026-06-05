import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from './errors.js';
import { logger } from './logger.js';

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
  } = options;

  const list = paths == null ? [] : Array.isArray(paths) ? paths : [paths];
  if (list.length === 0) {
    throw new ConfigError('createFileWatchSource: paths is required (a string or non-empty array)');
  }
  for (const p of list) {
    if (typeof p !== 'string') throw new ConfigError('createFileWatchSource: every path must be a string');
  }
  if (!(typeof debounceMs === 'number' && debounceMs > 0)) {
    throw new ConfigError('createFileWatchSource: debounceMs must be a positive number');
  }
  if (!(typeof pollIntervalMs === 'number' && pollIntervalMs > 0)) {
    throw new ConfigError('createFileWatchSource: pollIntervalMs must be a positive number');
  }
  if (filter != null && typeof filter !== 'function') {
    throw new ConfigError('createFileWatchSource: filter must be a function');
  }
  if (!Array.isArray(ignore)) {
    throw new ConfigError('createFileWatchSource: ignore must be an array of strings');
  }

  const absPaths = list.map((p) => path.resolve(p));
  void coalesce;

  let emitFn = null;
  let stopBackend = null;
  let started = false;

  const perPathTimers = new Map(); // path -> { timer, eventType }

  function mergeEventType(prev, next) {
    return prev === 'rename' || next === 'rename' ? 'rename' : next;
  }

  function safeEmit(event) {
    if (!emitFn) return;
    try {
      emitFn(event);
    } catch (err) {
      logger.warn(`file-watch-source emit threw: ${err.message}`);
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

  function passesFilters(absPath, eventType) {
    for (const sub of ignore) {
      if (typeof sub === 'string' && absPath.includes(sub)) return false;
    }
    if (filter && !filter(absPath, eventType)) return false;
    return true;
  }

  function onRaw(absPath, eventType) {
    if (!passesFilters(absPath, eventType)) return;
    emitPerPath(absPath, eventType);
  }

  return {
    start(emit) {
      if (started) {
        logger.warn('file-watch-source already started; ignoring');
        return;
      }
      started = true;
      emitFn = emit;
      try {
        stopBackend = _backend({ paths: absPaths, recursive, usePolling, pollIntervalMs }, onRaw);
      } catch (err) {
        logger.warn(`file-watch-source backend start threw: ${err.message}`);
      }
    },
    stop() {
      started = false;
      if (typeof stopBackend === 'function') {
        try {
          stopBackend();
        } catch (err) {
          logger.warn(`file-watch-source backend stop threw: ${err.message}`);
        }
      }
      stopBackend = null;
      for (const { timer } of perPathTimers.values()) clearTimeout(timer);
      perPathTimers.clear();
      emitFn = null;
    },
  };
}

function defaultBackend() {
  return () => {};
}
