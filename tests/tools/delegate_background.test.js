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

test('foreground Delegate writes a trace file with subagent activity', async () => {
  // run() receives the notify callback as its 2nd arg; emit synthetic events through it.
  mock.method(Agent.prototype, 'run', async function (_prompt, notify) {
    await notify({ reasoning: 'planning' });
    await notify({ content: 'doing the work' });
    await notify({ tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{}' } }] });
    await notify({ tool_start: { tool_call_id: 't1', name: 'Read', input: { file_path: '/a' } } });
    await notify({ tool_end: { tool_call_id: 't1', name: 'Read', duration_ms: 7, output: 'body' } });
    return 'final report from subagent';
  });
  const parent = await createAgent({ apiKey: 'x' });
  try {
    const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
    const out = await delegateExecute(
      { prompt: 'do work', description: 'do work' },
      { agent: parent, signal: new AbortController().signal },
    );
    const m = out.match(/Trace: (\S+)/);
    assert.ok(m, `expected Trace path in footer, got:\n${out}`);
    const trace = fs.readFileSync(m[1], 'utf8');
    assert.match(trace, /=== turn 1 ===/);
    assert.match(trace, /\[reasoning\]\nplanning/);
    assert.match(trace, /-> Read#t1 end \(7ms\): body/);
  } finally {
    await parent.cleanup();
  }
});
