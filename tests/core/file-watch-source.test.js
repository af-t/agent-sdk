import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileWatchSource } from '../../src/core/file-watch-source.js';

// A fake backend captures onRaw so tests drive synthetic fs events.
function fakeBackend() {
  let raw = null;
  let lastConfig = null;
  let stops = 0;
  const backend = (config, onRaw) => {
    lastConfig = config;
    raw = onRaw;
    return () => {
      stops += 1;
    };
  };
  return {
    backend,
    trigger: (p, eventType) => raw(p, eventType),
    config: () => lastConfig,
    stops: () => stops,
  };
}

function tick(ms = 30) {
  return new Promise((r) => setTimeout(r, ms));
}

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

test('emits one debounced per-file event with absolute path and eventType', async () => {
  const fb = fakeBackend();
  const events = [];
  const src = createFileWatchSource({ paths: 'a', debounceMs: 15, _backend: fb.backend });
  src.start((e) => events.push(e));
  fb.trigger('/abs/file.js', 'change');
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'file-change');
  assert.equal(events[0].path, '/abs/file.js');
  assert.equal(events[0].eventType, 'change');
  src.stop();
});

test('collapses a rapid burst for the same path into one event; rename wins', async () => {
  const fb = fakeBackend();
  const events = [];
  const src = createFileWatchSource({ paths: 'a', debounceMs: 15, _backend: fb.backend });
  src.start((e) => events.push(e));
  fb.trigger('/abs/x', 'change');
  fb.trigger('/abs/x', 'rename');
  fb.trigger('/abs/x', 'change');
  await tick();
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'rename');
  src.stop();
});

test('passes the resolved absolute config paths to the backend', () => {
  const fb = fakeBackend();
  const src = createFileWatchSource({ paths: ['a', 'b'], _backend: fb.backend });
  src.start(() => {});
  const cfg = fb.config();
  assert.equal(cfg.paths.length, 2);
  assert.ok(cfg.paths.every((p) => p.startsWith('/')));
  src.stop();
});

test('ignore drops paths whose absolute path contains a substring', async () => {
  const fb = fakeBackend();
  const events = [];
  const src = createFileWatchSource({
    paths: 'a',
    debounceMs: 15,
    ignore: ['node_modules', '.log'],
    _backend: fb.backend,
  });
  src.start((e) => events.push(e));
  fb.trigger('/proj/node_modules/x.js', 'change');
  fb.trigger('/proj/app.log', 'change');
  fb.trigger('/proj/src/main.js', 'change');
  await tick();
  assert.deepEqual(events.map((e) => e.path), ['/proj/src/main.js']);
  src.stop();
});

test('filter runs after ignore and can drop or pass events', async () => {
  const fb = fakeBackend();
  const events = [];
  const seen = [];
  const src = createFileWatchSource({
    paths: 'a',
    debounceMs: 15,
    ignore: ['node_modules'],
    filter: (p, eventType) => {
      seen.push([p, eventType]);
      return p.endsWith('.js');
    },
    _backend: fb.backend,
  });
  src.start((e) => events.push(e));
  fb.trigger('/proj/node_modules/x.js', 'change'); // dropped by ignore, never reaches filter
  fb.trigger('/proj/readme.md', 'change'); // reaches filter, dropped
  fb.trigger('/proj/main.js', 'rename'); // reaches filter, passes
  await tick();
  assert.deepEqual(events.map((e) => e.path), ['/proj/main.js']);
  assert.deepEqual(
    seen.map((s) => s[0]),
    ['/proj/readme.md', '/proj/main.js'],
  );
  src.stop();
});

test('type option overrides the emitted event.type', async () => {
  const fb = fakeBackend();
  const events = [];
  const src = createFileWatchSource({ paths: 'a', debounceMs: 15, type: 'fs', _backend: fb.backend });
  src.start((e) => events.push(e));
  fb.trigger('/abs/x', 'change');
  await tick();
  assert.equal(events[0].type, 'fs');
  src.stop();
});


