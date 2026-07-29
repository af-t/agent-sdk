import { test } from 'node:test';
/* eslint-disable prefer-const */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFileWatchSource } from '../../src/automation/file-watch-source.js';
import { createTestTempDir } from '../support/temp.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

// Integration test against the real polling backend (no _backend seam).
// Polling is the recommended mode on WSL2 / network FS, where it must still
// detect files created after watching started.
test('polling backend detects a newly created file in a watched directory', async (t) => {
  let src;
  t.after(() => src?.stop());
  const dir = createTestTempDir(t, 'fw-poll-');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed');
  const events = [];
  src = createFileWatchSource({ paths: [dir], usePolling: true, pollIntervalMs: 100, debounceMs: 20 });
  src.start((e) => events.push(e));
  await sleep(250);
  fs.writeFileSync(path.join(dir, 'fresh.txt'), 'created');
  const ok = await waitUntil(() => events.some((e) => String(e.path).endsWith('fresh.txt')), 3000);
  src.stop();
  assert.ok(ok, 'polling must emit an event for a file created after watching started');
});

test('polling backend still reports modifications to pre-existing files', async (t) => {
  let src;
  t.after(() => src?.stop());
  const dir = createTestTempDir(t, 'fw-poll-');
  const seed = path.join(dir, 'seed.txt');
  fs.writeFileSync(seed, 'seed');
  const events = [];
  src = createFileWatchSource({ paths: [dir], usePolling: true, pollIntervalMs: 100, debounceMs: 20 });
  src.start((e) => events.push(e));
  await sleep(250);
  fs.writeFileSync(seed, 'modified-' + Date.now());
  const ok = await waitUntil(() => events.some((e) => String(e.path).endsWith('seed.txt')), 3000);
  src.stop();
  assert.ok(ok, 'polling must still report modifications to existing files');
});
