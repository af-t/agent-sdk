import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';
import path from 'node:path';
import os from 'node:os';

// Helper: create a minimal agent with a stubbed _sendForTest to avoid real API calls.
async function makeAgent(opts = {}) {
  const agent = await createAgent({ apiKey: 'x', ...opts });
  return agent;
}

// Helper: stub _sendForTest with a sequence of responses.
function stubResponses(agent, responses) {
  let idx = 0;
  agent._sendForTest = async () => {
    const r = responses[idx++];
    if (!r) throw new Error(`unexpected call #${idx}`);
    return r;
  };
}

// Simple terminal response (model says text, no tool calls).
const terminalResponse = (text = 'done') => ({
  choices: [{ message: { content: text, reasoning: null, tool_calls: null } }],
  usage: { cost: 0, total_tokens: 0 },
});

// --- Bug C: Coupled Reminder Draining ---

test('Bug C: events are always queued to #pendingBgDrains regardless of autoWake setting', async () => {
  // With autoWake: false, events should still be queued so that a subsequent
  // manual run() call will drain them as system-reminder messages.
  const agent = await makeAgent({ autoWake: false });

  agent._fireBackgroundExit({
    id: 'bg-1',
    kind: 'bash',
    exitCode: 0,
    durationMs: 500,
    logPath: '/tmp/bg1.log',
    status: 'exited',
  });

  // Set up a simple terminal response
  stubResponses(agent, [terminalResponse('acknowledged')]);

  await agent.run('continue');

  // The bg exit should have been drained into messages as a system-reminder.
  const drained = agent.messages.find(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-1'),
  );
  assert.ok(drained, 'bg exit event should be drained into messages even with autoWake=false');
  assert.match(JSON.stringify(drained.content), /system-reminder/);
});

test('Bug C: multiple events queued without autoWake are all drained on next run()', async () => {
  const agent = await makeAgent({ autoWake: false });

  agent._fireBackgroundExit({
    id: 'bg-a',
    kind: 'bash',
    exitCode: 0,
    durationMs: 100,
    logPath: '/tmp/a.log',
    status: 'exited',
  });
  agent._fireBackgroundExit({
    id: 'bg-b',
    kind: 'delegate',
    exitCode: 1,
    durationMs: 200,
    logPath: '/tmp/b.log',
    status: 'exited',
  });

  stubResponses(agent, [terminalResponse('ok')]);
  await agent.run('check');

  const drained = agent.messages.filter(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('system-reminder'),
  );
  // Both events should appear in a single system-reminder message.
  const combined = JSON.stringify(drained);
  assert.ok(combined.includes('bg-a'), 'first event should be present');
  assert.ok(combined.includes('bg-b'), 'second event should be present');
});

// --- Bug A: Race Condition on Concurrent Exits ---

test('Bug A: rapid concurrent exits coalesce into a single autoWake run', async () => {
  const agent = await makeAgent({ autoWake: true });

  let runCount = 0;
  stubResponses(agent, [
    terminalResponse('woke-1'),
    terminalResponse('woke-2'), // should not be needed
  ]);
  const origRun = agent.run.bind(agent);
  agent.run = async function (...args) {
    runCount++;
    return origRun(...args);
  };

  // Fire two exits rapidly — both should be coalesced into a single wake-up.
  agent._fireBackgroundExit({
    id: 'rapid-1',
    kind: 'bash',
    exitCode: 0,
    durationMs: 50,
    logPath: '/tmp/r1.log',
    status: 'exited',
  });
  agent._fireBackgroundExit({
    id: 'rapid-2',
    kind: 'bash',
    exitCode: 0,
    durationMs: 60,
    logPath: '/tmp/r2.log',
    status: 'exited',
  });

  // Let microtasks flush.
  await new Promise((r) => setTimeout(r, 100));
  // Wait for the auto-wake run to complete.
  await new Promise((r) => setTimeout(r, 2000));

  assert.equal(runCount, 1, 'only one auto-wake run should occur for rapid concurrent exits');

  // Both events should be in the messages.
  const allMsgs = JSON.stringify(agent.messages);
  assert.ok(allMsgs.includes('rapid-1'), 'first rapid exit should be in messages');
  assert.ok(allMsgs.includes('rapid-2'), 'second rapid exit should be in messages');
});

// --- Bug B: Metadata & Notify Tracking ---

test('Bug B: autoWakeNotify callback is invoked during auto-wake run', async () => {
  const events = [];
  const notifyFn = (event) => {
    events.push(event);
  };

  const agent = await makeAgent({ autoWake: true, autoWakeNotify: notifyFn });

  // Use a tool call to generate non-turn_end events that #broadcast sends
  // to #notifyCallbacks (turn_end only goes to subscribedCallbacks).
  agent.use({
    name: 'ack',
    description: 'ack',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

  let call = 0;
  agent._sendForTest = async () => {
    call++;
    if (call === 1) {
      return {
        choices: [
          {
            message: {
              content: '',
              reasoning: null,
              tool_calls: [{ id: 'tc1', function: { name: 'ack', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      };
    }
    return terminalResponse('background-ack');
  };

  agent._fireBackgroundExit({
    id: 'bg-notify',
    kind: 'bash',
    exitCode: 0,
    durationMs: 100,
    logPath: '/tmp/n.log',
    status: 'exited',
  });

  // Wait for the auto-wake microtask and run to complete.
  await new Promise((r) => setTimeout(r, 3000));

  // The notify callback should have received tool_start/tool_end events.
  assert.ok(events.length > 0, 'autoWakeNotify should have been called during auto-wake run');
});

test('Bug B: autoWakeNotify can be set after construction', async () => {
  const agent = await makeAgent({ autoWake: true });

  const events = [];
  // Set the notify callback post-construction.
  agent.autoWakeNotify = (event) => events.push(event);

  // Use a tool call so the notify receives tool_start/tool_end events.
  agent.use({
    name: 'ack',
    description: 'ack',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

  let call = 0;
  agent._sendForTest = async () => {
    call++;
    if (call === 1) {
      return {
        choices: [
          {
            message: {
              content: '',
              reasoning: null,
              tool_calls: [{ id: 'tc1', function: { name: 'ack', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      };
    }
    return terminalResponse('late-notify');
  };

  agent._fireBackgroundExit({
    id: 'bg-late',
    kind: 'bash',
    exitCode: 0,
    durationMs: 50,
    logPath: '/tmp/late.log',
    status: 'exited',
  });

  await new Promise((r) => setTimeout(r, 3000));

  assert.ok(events.length > 0, 'late-bound autoWakeNotify should still be called');
});

test('Bug B: autoWakeOptions are forwarded to auto-wake run()', async () => {
  const agent = await makeAgent({ autoWake: true });

  const ac = new AbortController();
  agent.autoWakeOptions = { signal: ac.signal };

  // Abort immediately to test that the signal is forwarded.
  ac.abort();

  stubResponses(agent, [terminalResponse('should-not-reach')]);

  agent._fireBackgroundExit({
    id: 'bg-abort',
    kind: 'bash',
    exitCode: 0,
    durationMs: 100,
    logPath: '/tmp/abort.log',
    status: 'exited',
  });

  // Wait for the auto-wake microtask.
  await new Promise((r) => setTimeout(r, 500));

  // The run should have been aborted. The agent should NOT have completed a run.
  const msgs = JSON.stringify(agent.messages);
  assert.ok(!msgs.includes('should-not-reach'), 'aborted auto-wake should not produce a response');
});

// --- Combined scenarios ---

test('events arriving while isRunning are drained during the run loop', async () => {
  const agent = await makeAgent({ autoWake: false });

  agent.use({
    name: 'trigger_exit',
    description: 'triggers a background exit',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      // Simulate bg exit during tool execution.
      agent._fireBackgroundExit({
        id: 'mid-run',
        kind: 'bash',
        exitCode: 0,
        durationMs: 300,
        logPath: '/tmp/mid.log',
        status: 'exited',
      });
      return 'triggered';
    },
  });

  let call = 0;
  agent._sendForTest = async () => {
    call++;
    if (call === 1) {
      return {
        choices: [
          {
            message: {
              content: '',
              reasoning: null,
              tool_calls: [{ id: 'tc1', function: { name: 'trigger_exit', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      };
    }
    return terminalResponse('final');
  };

  await agent.run('go');

  const drained = agent.messages.find(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('mid-run'),
  );
  assert.ok(drained, 'bg exit during run should be drained into messages');
});

test('onBackgroundExit listeners still fire when autoWake is false', async () => {
  const agent = await makeAgent({ autoWake: false });
  let listenerCalled = false;
  agent.onBackgroundExit(() => {
    listenerCalled = true;
  });

  agent._fireBackgroundExit({
    id: 'listener-test',
    kind: 'bash',
    exitCode: 0,
    durationMs: 100,
    logPath: '/tmp/listener.log',
    status: 'exited',
  });

  assert.ok(listenerCalled, 'onBackgroundExit listener should fire even without autoWake');
});

test('onBackgroundExit listeners do NOT fire during active run (events queued)', async () => {
  const agent = await makeAgent({ autoWake: false });
  let listenerCalls = 0;
  agent.onBackgroundExit(() => {
    listenerCalls++;
  });

  agent.use({
    name: 'slow_tool',
    description: 'd',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      // During active run, listener should NOT be called.
      agent._fireBackgroundExit({
        id: 'during-run',
        kind: 'bash',
        exitCode: 0,
        durationMs: 100,
        logPath: '/tmp/during.log',
        status: 'exited',
      });
      return 'ok';
    },
  });

  let call = 0;
  agent._sendForTest = async () => {
    call++;
    if (call === 1) {
      return {
        choices: [
          {
            message: {
              content: '',
              reasoning: null,
              tool_calls: [{ id: 'tc1', function: { name: 'slow_tool', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      };
    }
    return terminalResponse('done');
  };

  await agent.run('test');

  assert.equal(listenerCalls, 0, 'onBackgroundExit listener should NOT fire during active run');
});
