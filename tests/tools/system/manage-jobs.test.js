import { describe, it, test, mock } from 'node:test';
/* eslint-disable prefer-const */
import assert from 'node:assert/strict';

import Agent from '../../../src/core/agent.js';
import createAgent from '../../../src/index.js';
import { manageJobs } from '../../../src/tools/system/manage-jobs.js';
import { createTestTempDir } from '../../support/temp.js';

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-test-jobs';

function makeAgent() {
  return new Agent({ apiKey: 'sk-test-jobs' });
}

describe('manageJobs tool', () => {
  it('exports the manageJobs name and a flat schema requiring action', () => {
    assert.equal(manageJobs.name, 'manageJobs');
    assert.deepEqual(manageJobs.inputSchema.required, ['action']);
    assert.deepEqual(manageJobs.inputSchema.properties.action.enum, ['list', 'stop']);
  });

  it('requires ctx.agent', async () => {
    await assert.rejects(() => manageJobs.execute({ action: 'list' }, {}), /ctx\.agent/);
  });

  it('list returns a friendly message when nothing is running', async () => {
    const agent = makeAgent();
    const out = await manageJobs.execute({ action: 'list' }, { agent });
    assert.match(out, /no running background jobs/i);
  });

  it('list shows only running jobs by default', async () => {
    const agent = makeAgent();
    const now = Date.now();
    agent.backgroundJobs.register({ id: 'bg-run01', kind: 'bash', status: 'running', startedAt: now - 1000 });
    agent.backgroundJobs.register({
      id: 'bg-fin01',
      kind: 'delegate',
      status: 'exited',
      exitCode: 0,
      startedAt: now - 3000,
      endedAt: now - 1500,
    });
    const out = await manageJobs.execute({ action: 'list' }, { agent });
    assert.match(out, /bg-run01/);
    assert.doesNotMatch(out, /bg-fin01/);
  });

  it('list with all:true includes finished jobs', async () => {
    const agent = makeAgent();
    const now = Date.now();
    agent.backgroundJobs.register({ id: 'bg-run02', kind: 'bash', status: 'running', startedAt: now - 1000 });
    agent.backgroundJobs.register({
      id: 'bg-fin02',
      kind: 'timer',
      status: 'done',
      exitCode: 0,
      startedAt: now - 3000,
      endedAt: now - 1500,
    });
    const out = await manageJobs.execute({ action: 'list', all: true }, { agent });
    assert.match(out, /bg-run02/);
    assert.match(out, /bg-fin02/);
    assert.match(out, /code 0/);
  });

  it('stop requires jobId', async () => {
    const agent = makeAgent();
    await assert.rejects(() => manageJobs.execute({ action: 'stop' }, { agent }), /jobId/);
  });

  it('stop on a missing job returns a not-found message', async () => {
    const agent = makeAgent();
    const out = await manageJobs.execute({ action: 'stop', jobId: 'bg-zzzzz' }, { agent });
    assert.match(out, /not found/i);
  });

  it('stop on an already-finished job is a no-op message', async () => {
    const agent = makeAgent();
    agent.backgroundJobs.register({
      id: 'bg-done1',
      kind: 'bash',
      status: 'exited',
      startedAt: Date.now() - 500,
    });
    const out = await manageJobs.execute({ action: 'stop', jobId: 'bg-done1' }, { agent });
    assert.match(out, /already/i);
  });

  it('stop bash sends SIGTERM to the child process', async () => {
    const agent = makeAgent();
    let sig = null;
    const child = {
      kill: (s) => {
        sig = s;
      },
      on: (ev, cb) => {
        if (ev === 'exit') cb();
      },
    };
    agent.backgroundJobs.register({
      id: 'bg-bash1',
      kind: 'bash',
      status: 'running',
      startedAt: Date.now(),
      child,
    });
    const out = await manageJobs.execute({ action: 'stop', jobId: 'bg-bash1' }, { agent });
    assert.equal(sig, 'SIGTERM');
    assert.match(out, /bg-bash1/);
  });

  it('stop delegate aborts its controller and marks the job killed', async () => {
    const agent = makeAgent();
    const controller = new AbortController();
    const job = {
      id: 'bg-del01',
      kind: 'delegate',
      status: 'running',
      startedAt: Date.now(),
      child: null,
      controller,
    };
    agent.backgroundJobs.register(job);
    await manageJobs.execute({ action: 'stop', jobId: 'bg-del01' }, { agent });
    assert.equal(controller.signal.aborted, true);
    assert.equal(job.status, 'killed');
  });

  it('stop timer clears it and marks the job killed', async () => {
    const agent = makeAgent();
    const timer = setTimeout(() => {}, 100000);
    const job = { id: 'bg-tim01', kind: 'timer', status: 'running', startedAt: Date.now(), timer };
    agent.backgroundJobs.register(job);
    await manageJobs.execute({ action: 'stop', jobId: 'bg-tim01' }, { agent });
    assert.equal(job.status, 'killed');
  });
});

test('cleanup aborts a running background delegateTask controller', async (t) => {
  let parent;
  t.after(() => parent?.cleanup());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir } });
  const controller = new AbortController();
  parent.backgroundJobs.register({
    id: 'bg-clean',
    kind: 'delegate',
    status: 'running',
    startedAt: Date.now(),
    child: null,
    controller,
  });
  await parent.cleanup();
  assert.equal(controller.signal.aborted, true);
});

test('manageJobs stop terminates a real background delegateTask (status killed)', async (t) => {
  // Subagent run blocks until its signal aborts, then throws like the real run loop.
  mock.method(Agent.prototype, 'run', function (_prompt, _notify, opts) {
    return new Promise((_resolve, reject) => {
      const sig = opts?.signal;
      if (sig?.aborted) return reject(new Error('Agent run aborted'));
      sig?.addEventListener('abort', () => reject(new Error('Agent run aborted')), { once: true });
    });
  });

  let parent;
  let dispose = () => {};
  t.after(() => parent?.cleanup());
  t.after(() => dispose());
  const tmpDir = createTestTempDir(t, 'delegate-parent-');
  parent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir } });
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  dispose = parent._onBackgroundExitRaw((e) => {
    if (e.kind === 'delegate') resolveExit(e);
  });

  const {
    delegateTask: { execute: delegateExecute },
  } = await import('../../../src/tools/system/delegate-task.js');
  const out = await delegateExecute(
    { prompt: 'long task', description: 'long task', background: true },
    { agent: parent, signal: new AbortController().signal },
  );
  const jobId = out.match(/Job ID: (bg-\S+)/)[1];
  const job = parent.backgroundJobs.get(jobId);
  assert.equal(job.status, 'running');

  const stopOut = await manageJobs.execute({ action: 'stop', jobId }, { agent: parent });
  assert.match(stopOut, new RegExp(jobId));

  const event = await exited;
  assert.equal(event.status, 'killed');
  assert.equal(job.status, 'killed');
});
