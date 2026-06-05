import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileWatchSource } from '../../src/core/file-watch-source.js';

test('throws ConfigError when paths is missing or empty', () => {
  assert.throws(() => createFileWatchSource({}), /paths is required/);
  assert.throws(() => createFileWatchSource({ paths: [] }), /paths is required/);
});

test('throws when a path is not a string', () => {
  assert.throws(() => createFileWatchSource({ paths: [123] }), /must be a string/);
});

test('throws on non-positive debounceMs and pollIntervalMs', () => {
  assert.throws(() => createFileWatchSource({ paths: 'a', debounceMs: 0 }), /debounceMs/);
  assert.throws(() => createFileWatchSource({ paths: 'a', pollIntervalMs: -1 }), /pollIntervalMs/);
});

test('throws when filter is not a function and when ignore is not an array', () => {
  assert.throws(() => createFileWatchSource({ paths: 'a', filter: 'x' }), /filter must be a function/);
  assert.throws(() => createFileWatchSource({ paths: 'a', ignore: 'x' }), /ignore must be an array/);
});

test('returns a source object with start and stop', () => {
  const src = createFileWatchSource({ paths: 'a' });
  assert.equal(typeof src.start, 'function');
  assert.equal(typeof src.stop, 'function');
});
