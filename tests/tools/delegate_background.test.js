import { test, mock } from 'node:test';
/* eslint-disable prefer-const */
import assert from 'node:assert/strict';
import fs from 'node:fs';

import createAgent from '../../src/index.js';
import Agent from '../../src/core/agent.js';
import { createTestTempDir } from '../support/temp.js';

test('Delegate-spawned subagent inherits parent.restricted', async (t) => {
  mock.method(Agent.prototype, 'run', async () => 'subagent report');
  let parent;
  t.after(() => parent?.cleanup());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({ apiKey: 'x', restricted: false, storagePaths: { tmpDir } });

  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  const out = await delegateExecute(
    { agent: 'researcher', prompt: 'test', description: 'test delegation' },
    { agent: parent, signal: new AbortController().signal },
  );
  assert.match(out, /Subagent ID:/);
  const child = [...parent.subagents.values()][0];
  assert.equal(child.restricted, false);
});

test('Delegate-spawned subagent shares parent storagePaths.tmpDir', async (t) => {
  mock.method(Agent.prototype, 'run', async () => 'r');
  let parent;
  t.after(() => parent?.cleanup());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({
    apiKey: 'x',
    storagePaths: { tmpDir },
  });
  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  await delegateExecute(
    { agent: 'researcher', prompt: 'test', description: 'test delegation' },
    { agent: parent, signal: new AbortController().signal },
  );
  const child = [...parent.subagents.values()][0];
  assert.equal(child._storagePaths?.tmpDir, tmpDir);
});

test('Delegate background:true returns immediately with job id', async (t) => {
  let parent;
  t.after(() => parent?.cleanup());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir } });

  // Mock Agent.prototype.run: covers both parent and any subagent instances.
  let resolveSubagent;
  const subagentDone = new Promise((r) => {
    resolveSubagent = r;
  });
  mock.method(Agent.prototype, 'run', async function () {
    await new Promise((r) => setTimeout(r, 100));
    resolveSubagent();
    return 'final report from subagent';
  });

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
});

test('foreground Delegate writes a trace file with subagent activity', async (t) => {
  // run() receives the notify callback as its 2nd arg; emit synthetic events through it.
  mock.method(Agent.prototype, 'run', async function (_prompt, notify) {
    await notify({ reasoning: 'planning' });
    await notify({ content: 'doing the work' });
    await notify({ tool_calls: [{ id: 't1', function: { name: 'readFile', arguments: '{}' } }] });
    await notify({ tool_start: { tool_call_id: 't1', name: 'readFile', input: { path: '/a' } } });
    await notify({ tool_end: { tool_call_id: 't1', name: 'readFile', duration_ms: 7, output: 'body' } });
    return 'final report from subagent';
  });
  let parent;
  t.after(() => parent?.cleanup());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir } });
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
  assert.match(trace, /-> readFile#t1 end \(7ms\): body/);
});

test('background Delegate streams a trace file and exit event carries traceLogPath', async (t) => {
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  mock.method(Agent.prototype, 'run', async function (_prompt, notify) {
    await notify({ content: 'bg work' });
    await notify({ tool_calls: [{ id: 'b1', function: { name: 'Bash' } }] });
    await notify({ tool_end: { tool_call_id: 'b1', name: 'Bash', duration_ms: 3, output: 'ok' } });
    return 'bg final report';
  });
  let parent;
  t.after(() => parent?.cleanup());
  let dispose = () => {};
  t.after(() => dispose());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir } });
  const seen = [];
  dispose = parent._onBackgroundExitRaw((e) => {
    seen.push(e);
    resolveDone();
  });
  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  const out = await delegateExecute(
    { prompt: 'do work', description: 'do work', background: true },
    { agent: parent, signal: new AbortController().signal },
  );
  const m = out.match(/Trace \(live\): (\S+)/);
  assert.ok(m, `expected Trace (live) path, got:\n${out}`);

  await done;
  await new Promise((r) => setTimeout(r, 50));

  const event = seen.find((e) => e.kind === 'delegate');
  assert.ok(event.traceLogPath, 'exit event should carry traceLogPath');
  const trace = fs.readFileSync(event.traceLogPath, 'utf8');
  assert.match(trace, /\[assistant\]\nbg work/);
  assert.match(trace, /-> Bash#b1 end \(3ms\): ok/);
});
