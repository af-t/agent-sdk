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
  void absPaths;
  void recursive;
  void usePolling;
  void coalesce;
  void type;
  void _backend;

  return {
    start(_emit) {},
    stop() {},
  };
}

function defaultBackend() {
  return () => {};
}
