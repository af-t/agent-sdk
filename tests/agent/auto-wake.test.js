import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';

async function makeAgent(opts = {}) {
  const agent = await createAgent({ apiKey: 'x', ...opts });
  return agent;
}

function stubResponses(agent, responses) {
  let idx = 0;
  agent._sendForTest = async () => {
    const r = responses[idx++];
    if (!r) throw new Error(`unexpected call #${idx}`);
    return r;
  };
}

const terminalResponse = (text = 'done') => ({
  choices: [{ message: { content: text, reasoning: null, tool_calls: null } }],
  usage: { cost: 0, total_tokens: 0 },
});

test('exit events remain queued for the next manual run when autoWake is disabled', async () => {
  // A later manual run still needs the exit reminder when automatic wake-up is disabled.
  const agent = await makeAgent({ autoWake: false });

  agent._fireBackgroundExit({
    id: 'bg-1',
    kind: 'bash',
    exitCode: 0,
    durationMs: 500,
    logPath: '/tmp/bg1.log',
    status: 'exited',
  });

  stubResponses(agent, [terminalResponse('acknowledged')]);

  await agent.run('continue');

  const drained = agent.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-1'));
  assert.ok(drained, 'manual run should receive the queued background exit');
  assert.match(JSON.stringify(drained.content), /system-reminder/);
});

test('the next manual run drains every exit queued while autoWake is disabled', async () => {
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
  // Both events share one system reminder.
  const combined = JSON.stringify(drained);
  assert.ok(combined.includes('bg-a'), 'first event should be present');
  assert.ok(combined.includes('bg-b'), 'second event should be present');
});

test('rapid concurrent exits coalesce into one autoWake run', async () => {
  const agent = await makeAgent({ autoWake: true });

  let runCount = 0;
  stubResponses(agent, [terminalResponse('woke-1'), terminalResponse('woke-2')]);
  const origRun = agent.run.bind(agent);
  agent.run = async function (...args) {
    runCount++;
    return origRun(...args);
  };

  // Closely timed exits share the same wake-up.
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

  await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 2000));

  assert.equal(runCount, 1, 'only one auto-wake run should occur for rapid concurrent exits');

  const allMsgs = JSON.stringify(agent.messages);
  assert.ok(allMsgs.includes('rapid-1'), 'first rapid exit should be in messages');
  assert.ok(allMsgs.includes('rapid-2'), 'second rapid exit should be in messages');
});

test('autoWakeNotify receives events from an automatic wake-up', async () => {
  const events = [];
  const notifyFn = (event) => {
    events.push(event);
  };

  const agent = await makeAgent({ autoWake: true, autoWakeNotify: notifyFn });

  // A tool call produces events for the notification callback.
  agent.registerTools({
    name: 'ack',
    description: 'ack',
    inputSchema: { type: 'object', properties: {} },
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

  await new Promise((r) => setTimeout(r, 3000));

  assert.ok(events.length > 0, 'autoWakeNotify should have been called during auto-wake run');
});

test('autoWakeNotify can be set after construction', async () => {
  const agent = await makeAgent({ autoWake: true });

  const events = [];
  agent.autoWakeNotify = (event) => events.push(event);

  // A tool call gives the late-bound callback an event to receive.
  agent.registerTools({
    name: 'ack',
    description: 'ack',
    inputSchema: { type: 'object', properties: {} },
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

test('autoWakeOptions are forwarded to the automatic run', async () => {
  const agent = await makeAgent({ autoWake: true });

  const ac = new AbortController();
  agent.autoWakeOptions = { signal: ac.signal };

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

  await new Promise((r) => setTimeout(r, 500));

  const msgs = JSON.stringify(agent.messages);
  assert.ok(!msgs.includes('should-not-reach'), 'aborted auto-wake should not produce a response');
});

test('events arriving during a run drain before the run ends', async () => {
  const agent = await makeAgent({ autoWake: false });

  agent.registerTools({
    name: 'trigger_exit',
    description: 'triggers a background exit',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      // The tool reports a background exit while the run is active.
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

  const drained = agent.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('mid-run'));
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

test('onBackgroundExit listeners wait while a run is active', async () => {
  const agent = await makeAgent({ autoWake: false });
  let listenerCalls = 0;
  agent.onBackgroundExit(() => {
    listenerCalls++;
  });

  agent.registerTools({
    name: 'slow_tool',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      // The active run queues this event instead of notifying the listener.
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

test('a queued background exit merges into the next prompt once', async () => {
  const agent = await makeAgent({ autoWake: false });
  agent.registerTools({
    name: 'noop',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'ok',
  });

  // An idle exit waits for the next manual run.
  agent._fireBackgroundExit({
    id: 'bg-start',
    kind: 'bash',
    exitCode: 0,
    durationMs: 100,
    logPath: '/tmp/s.log',
    status: 'exited',
  });

  let call = 0;
  agent._sendForTest = async () => {
    call += 1;
    if (call === 1) {
      return {
        choices: [
          {
            message: {
              content: '',
              reasoning: null,
              tool_calls: [{ id: 't1', function: { name: 'noop', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      };
    }
    return terminalResponse('done');
  };

  await agent.run('what happened');

  const reminders = agent.messages.filter(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('Background job(s) exited'),
  );
  // The run drains the reminder once at the start and does not repeat it after the tool group.
  assert.equal(reminders.length, 1, 'exactly one bg-exit reminder');
  // Merging the reminder into the prompt exposes it on the first turn.
  assert.match(JSON.stringify(reminders[0].content), /what happened/);
});

test('autoWake resumes when a background exit lands on the terminal turn', async () => {
  const agent = await makeAgent({ autoWake: true });

  let call = 0;
  agent._sendForTest = async () => {
    call += 1;
    if (call === 1) {
      // This exit arrives during the run on the way to a terminal turn.
      agent._fireBackgroundExit({
        id: 'bg-term',
        kind: 'bash',
        exitCode: 0,
        durationMs: 100,
        logPath: '/tmp/t.log',
        status: 'exited',
      });
      return terminalResponse('first');
    }
    return terminalResponse('second');
  };

  const result = await agent.run('go');

  // The loop resumes so the model can handle the late exit.
  assert.equal(result, 'second', 'loop resumed and produced a follow-up turn');
  const reminders = agent.messages.filter((m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-term'));
  assert.equal(reminders.length, 1, 'exactly one bg-exit reminder');
  const firstIdx = agent.messages.findIndex((m) => m.role === 'assistant' && m.content === 'first');
  const remIdx = agent.messages.findIndex((m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-term'));
  const secondIdx = agent.messages.findIndex((m) => m.role === 'assistant' && m.content === 'second');
  assert.ok(firstIdx >= 0 && remIdx > firstIdx && secondIdx > remIdx, 'order: first -> reminder -> second');
});

test('a terminal-turn exit waits for the consumer when autoWake is disabled', async () => {
  const agent = await makeAgent({ autoWake: false });

  let call = 0;
  agent._sendForTest = async () => {
    call += 1;
    if (call === 1) {
      agent._fireBackgroundExit({
        id: 'bg-noresume',
        kind: 'bash',
        exitCode: 0,
        durationMs: 100,
        logPath: '/tmp/nr.log',
        status: 'exited',
      });
      return terminalResponse('only');
    }
    throw new Error('should not run a second turn when autoWake is false');
  };

  await agent.run('go');

  assert.equal(call, 1, 'run ends on the terminal turn without resuming');
  // History keeps the reminder for the next manual run.
  const reminders = agent.messages.filter(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-noresume'),
  );
  assert.equal(reminders.length, 1, 'reminder is preserved in history');
});
