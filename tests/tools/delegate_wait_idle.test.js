import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';
import Agent from '../../src/core/agent.js';

test('foreground Delegate waits for subagent background jobs to finish', async () => {
  const parent = await createAgent({ apiKey: 'x' });

  // When subagent runs, it simulates returning a report but leaving a running job
  mock.method(Agent.prototype, 'run', async function () {
    // Simulate a background job
    this.backgroundJobs.set('bg-test', {
      status: 'running',
    });

    // Simulate the job finishing after 300ms
    setTimeout(() => {
      this.backgroundJobs.get('bg-test').status = 'exited';
      // Simulate autoWake run
      this.messages.push({ role: 'assistant', content: 'final report after autowake' });
    }, 300);

    return 'initial report';
  });

  try {
    const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
    const t0 = Date.now();
    const out = await delegateExecute(
      { agent: 'researcher', prompt: 'do work', description: 'do work', background: false },
      { agent: parent, signal: new AbortController().signal },
    );
    const elapsed = Date.now() - t0;

    // It should have waited for the background job to finish (>300ms)
    assert.ok(elapsed >= 300, `expected to wait for bg job, took ${elapsed}ms`);

    // It should have picked up the final message from the autowake
    assert.match(out, /final report after autowake/);
  } finally {
    await parent.cleanup();
  }
});
