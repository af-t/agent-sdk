import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../../src/index.js';
import Agent from '../../../src/agent/agent.js';

test('foreground delegateTask waits for subagent background jobs to finish', async () => {
  const parent = await createAgent({ apiKey: 'x' });

  // The subagent returns a report while one of its jobs is still running.
  mock.method(Agent.prototype, 'run', async function () {
    // This job remains active until the timer completes.
    this.backgroundJobs.register({
      id: 'bg-test',
      status: 'running',
    });

    // The timer completes the job after 300 ms.
    setTimeout(() => {
      this.backgroundJobs.get('bg-test').status = 'exited';
      // The automatic wake-up stores the subagent's final message.
      this.messages.push({ role: 'assistant', content: 'final report after autowake' });
    }, 300);

    return 'initial report';
  });

  try {
    const {
      delegateTask: { execute: delegateExecute },
    } = await import('../../../src/tools/system/delegate-task.js');
    const t0 = Date.now();
    const out = await delegateExecute(
      { agent: 'researcher', prompt: 'do work', description: 'do work', background: false },
      { agent: parent, signal: new AbortController().signal },
    );
    const elapsed = Date.now() - t0;

    // The call waits until the background job finishes.
    assert.ok(elapsed >= 300, `expected to wait for bg job, took ${elapsed}ms`);

    // The result includes the message collected during automatic wake-up.
    assert.match(out, /final report after autowake/);
  } finally {
    await parent.cleanup();
  }
});
