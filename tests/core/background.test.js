import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';

test('agent.backgroundJobs starts empty', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  assert.ok(agent.backgroundJobs instanceof Map);
  assert.equal(agent.backgroundJobs.size, 0);
});

test('onBackgroundExit registers a listener and returns a disposer', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  let called = 0;
  const dispose = agent.onBackgroundExit(() => {
    called += 1;
  });
  assert.equal(typeof dispose, 'function');

  agent._fireBackgroundExit({ id: 'bg-test', kind: 'bash', exitCode: 0 });
  assert.equal(called, 1);

  dispose();
  agent._fireBackgroundExit({ id: 'bg-test', kind: 'bash', exitCode: 0 });
  assert.equal(called, 1, 'disposer should remove listener');
});

test('multiple listeners all fire on the same event', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  let a = 0;
  let b = 0;
  agent.onBackgroundExit(() => (a += 1));
  agent.onBackgroundExit(() => (b += 1));
  agent._fireBackgroundExit({ id: 'bg-x', kind: 'bash', exitCode: 0 });
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('onBackgroundExit throws on non-function', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  assert.throws(() => agent.onBackgroundExit('not a fn'), TypeError);
});
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

test('background log dir uses storagePaths.tmpDir when configured', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'or-bg-'));
  const agent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir: tmp } });
  const dir = agent._resolveBackgroundLogDir();
  assert.equal(dir, fs.realpathSync(tmp));
  fs.rmSync(tmp, { recursive: true });
});

test('background log dir falls back to os.tmpdir/openrouter-<pid> when unconfigured', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  const dir = agent._resolveBackgroundLogDir();
  const expected = path.join(os.tmpdir(), `openrouter-${process.pid}`);
  assert.equal(dir, fs.realpathSync(expected));
  assert.ok(fs.existsSync(dir));
  assert.ok(agent.trustedPaths.has(dir));
});
