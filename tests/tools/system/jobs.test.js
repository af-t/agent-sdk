import { describe, it, test, mock } from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../../../src/core/agent.js';
import createAgent from '../../../src/index.js';
import { execute as jobsExecute, name, input_schema } from '../../../src/tools/system/jobs.js';

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-test-jobs';

function makeAgent() {
  return new Agent({ apiKey: 'sk-test-jobs' });
}

describe('Jobs tool', () => {
  it('exports Jobs name and a flat schema requiring action', () => {
    assert.equal(name, 'Jobs');
    assert.deepEqual(input_schema.required, ['action']);
    assert.deepEqual(input_schema.properties.action.enum, ['list', 'stop']);
  });

  it('requires ctx.agent', async () => {
    await assert.rejects(() => jobsExecute({ action: 'list' }, {}), /ctx\.agent/);
  });

  it('list returns a friendly message when nothing is running', async () => {
    const agent = makeAgent();
    const out = await jobsExecute({ action: 'list' }, { agent });
    assert.match(out, /no running background jobs/i);
  });

  it('list shows only running jobs by default', async () => {
    const agent = makeAgent();
    const now = Date.now();
    agent.backgroundJobs.set('bg-run01', { id: 'bg-run01', kind: 'bash', status: 'running', startedAt: now - 1000 });
    agent.backgroundJobs.set('bg-fin01', {
      id: 'bg-fin01',
      kind: 'delegate',
      status: 'exited',
      exitCode: 0,
      startedAt: now - 3000,
      endedAt: now - 1500,
    });
    const out = await jobsExecute({ action: 'list' }, { agent });
    assert.match(out, /bg-run01/);
    assert.doesNotMatch(out, /bg-fin01/);
  });

  it('list with all:true includes finished jobs', async () => {
    const agent = makeAgent();
    const now = Date.now();
    agent.backgroundJobs.set('bg-run02', { id: 'bg-run02', kind: 'bash', status: 'running', startedAt: now - 1000 });
    agent.backgroundJobs.set('bg-fin02', {
      id: 'bg-fin02',
      kind: 'timer',
      status: 'done',
      exitCode: 0,
      startedAt: now - 3000,
      endedAt: now - 1500,
    });
    const out = await jobsExecute({ action: 'list', all: true }, { agent });
    assert.match(out, /bg-run02/);
    assert.match(out, /bg-fin02/);
    assert.match(out, /code 0/);
  });

  it('stop requires job_id', async () => {
    const agent = makeAgent();
    await assert.rejects(() => jobsExecute({ action: 'stop' }, { agent }), /job_id/);
  });

  it('stop on a missing job returns a not-found message', async () => {
    const agent = makeAgent();
    const out = await jobsExecute({ action: 'stop', job_id: 'bg-zzzzz' }, { agent });
    assert.match(out, /not found/i);
  });

  it('stop on an already-finished job is a no-op message', async () => {
    const agent = makeAgent();
    agent.backgroundJobs.set('bg-done1', {
      id: 'bg-done1',
      kind: 'bash',
      status: 'exited',
      startedAt: Date.now() - 500,
    });
    const out = await jobsExecute({ action: 'stop', job_id: 'bg-done1' }, { agent });
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
    agent.backgroundJobs.set('bg-bash1', {
      id: 'bg-bash1',
      kind: 'bash',
      status: 'running',
      startedAt: Date.now(),
      child,
    });
    const out = await jobsExecute({ action: 'stop', job_id: 'bg-bash1' }, { agent });
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
    agent.backgroundJobs.set('bg-del01', job);
    await jobsExecute({ action: 'stop', job_id: 'bg-del01' }, { agent });
    assert.equal(controller.signal.aborted, true);
    assert.equal(job.status, 'killed');
  });

  it('stop timer clears it and marks the job killed', async () => {
    const agent = makeAgent();
    const timer = setTimeout(() => {}, 100000);
    const job = { id: 'bg-tim01', kind: 'timer', status: 'running', startedAt: Date.now(), timer };
    agent.backgroundJobs.set('bg-tim01', job);
    await jobsExecute({ action: 'stop', job_id: 'bg-tim01' }, { agent });
    assert.equal(job.status, 'killed');
  });
});

describe('_killBackgroundJob helper', () => {
  it('returns not_found for unknown ids', () => {
    const agent = makeAgent();
    assert.equal(agent._killBackgroundJob('bg-nope').status, 'not_found');
  });

  it('returns already_finished for non-running jobs', () => {
    const agent = makeAgent();
    agent.backgroundJobs.set('bg-x', { id: 'bg-x', kind: 'bash', status: 'crashed', startedAt: Date.now() });
    const res = agent._killBackgroundJob('bg-x');
    assert.equal(res.status, 'already_finished');
    assert.equal(res.jobStatus, 'crashed');
  });
});

test('cleanup aborts a running background Delegate controller', async () => {
  const parent = await createAgent({ apiKey: 'x' });
  const controller = new AbortController();
  parent.backgroundJobs.set('bg-clean', {
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

test('Jobs stop terminates a real background Delegate (status killed)', async () => {
  // Subagent run blocks until its signal aborts, then throws like the real run loop.
  mock.method(Agent.prototype, 'run', function (_prompt, _notify, opts) {
    return new Promise((_resolve, reject) => {
      const sig = opts?.signal;
      if (sig?.aborted) return reject(new Error('Agent run aborted'));
      sig?.addEventListener('abort', () => reject(new Error('Agent run aborted')), { once: true });
    });
  });

  const parent = await createAgent({ apiKey: 'x' });
  let resolveExit;
  const exited = new Promise((r) => (resolveExit = r));
  const dispose = parent._onBackgroundExitRaw((e) => {
    if (e.kind === 'delegate') resolveExit(e);
  });

  try {
    const { execute: delegateExecute } = await import('../../../src/tools/system/delegate.js');
    const out = await delegateExecute(
      { prompt: 'long task', description: 'long task', background: true },
      { agent: parent, signal: new AbortController().signal },
    );
    const jobId = out.match(/Job ID: (bg-\S+)/)[1];
    const job = parent.backgroundJobs.get(jobId);
    assert.equal(job.status, 'running');

    const stopOut = await jobsExecute({ action: 'stop', job_id: jobId }, { agent: parent });
    assert.match(stopOut, new RegExp(jobId));

    const event = await exited;
    assert.equal(event.status, 'killed');
    assert.equal(job.status, 'killed');
  } finally {
    dispose();
    await parent.cleanup();
  }
});
