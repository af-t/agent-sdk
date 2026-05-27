import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import createAgent from '../../src/index.js';
import Agent from '../../src/core/agent.js';

test('Delegate-spawned subagent inherits parent.restricted', async () => {
  mock.method(Agent.prototype, 'run', async () => 'subagent report');
  const parent = await createAgent({ apiKey: 'x', restricted: false });

  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  const out = await delegateExecute(
    { agent: 'researcher', prompt: 'test', description: 'test delegation' },
    { agent: parent, signal: new AbortController().signal },
  );
  assert.match(out, /Subagent ID:/);
  const child = [...parent.subagents.values()][0];
  assert.equal(child.restricted, false);
});

test('Delegate-spawned subagent shares parent storagePaths.tmpDir', async () => {
  mock.method(Agent.prototype, 'run', async () => 'r');
  const parent = await createAgent({
    apiKey: 'x',
    storagePaths: { tmpDir: '/tmp/openrouter-parent-test' },
  });
  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  await delegateExecute(
    { agent: 'researcher', prompt: 'test', description: 'test delegation' },
    { agent: parent, signal: new AbortController().signal },
  );
  const child = [...parent.subagents.values()][0];
  assert.equal(child._storagePaths?.tmpDir, '/tmp/openrouter-parent-test');
});

test('Delegate background:true returns immediately with job id', async () => {
  const parent = await createAgent({ apiKey: 'x' });

  // Mock Agent.prototype.run — covers both parent and any subagent instances.
  let resolveSubagent;
  const subagentDone = new Promise((r) => {
    resolveSubagent = r;
  });
  mock.method(Agent.prototype, 'run', async function () {
    await new Promise((r) => setTimeout(r, 100));
    resolveSubagent();
    return 'final report from subagent';
  });

  try {
    const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
    const t0 = Date.now();
    const out = await delegateExecute(
      { agent: 'researcher', prompt: 'do work', description: 'do work', background: true },
      { agent: parent, signal: new AbortController().signal },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 80, `expected immediate return, took ${elapsed}ms`);
    assert.match(out, /Subagent started in background/);
    assert.match(out, /Job ID: bg-/);

    // Wait for subagent to actually finish.
    await subagentDone;
    await new Promise((r) => setTimeout(r, 100));

    const ids = [...parent.backgroundJobs.keys()];
    assert.equal(ids.length, 1);
    const job = parent.backgroundJobs.get(ids[0]);
    assert.equal(job.kind, 'delegate');
    assert.equal(job.status, 'exited');
    const content = fs.readFileSync(job.logPath, 'utf8');
    assert.match(content, /final report from subagent/);
  } finally {
    await parent.cleanup();
  }
});
