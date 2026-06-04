import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';
import { createCopilot, extractGoal, renderWindow, buildInput } from '../../src/core/copilot.js';

test('subscribe registers a persistent listener and returns a disposer', async () => {
  const agent = new Agent({ apiKey: 'x', model: 'm' });
  const seen = [];
  const dispose = agent.subscribe((e) => seen.push(e));

  // drive one terminal turn with no network
  agent._sendForTest = async () => ({ choices: [{ message: { content: 'done', tool_calls: undefined } }] });
  await agent.run('hi');

  assert.ok(seen.length > 0, 'listener should receive at least one event');
  dispose();
  const countAfter = seen.length;
  await agent.run('again');
  assert.equal(seen.length, countAfter, 'disposed listener receives nothing');
});

test('subscribe throws on non-function', () => {
  const agent = new Agent({ apiKey: 'x', model: 'm' });
  assert.throws(() => agent.subscribe(123), TypeError);
});

test('run loop broadcasts turn_end with terminal flag', async () => {
  const agent = new Agent({ apiKey: 'x', model: 'm' });
  const ends = [];
  agent.subscribe((e) => {
    if (e.turn_end) ends.push(e.turn_end);
  });
  agent._sendForTest = async () => ({ choices: [{ message: { content: 'done' } }] });
  await agent.run('hi');

  assert.equal(ends.length, 1);
  assert.equal(ends[0].turn, 1);
  assert.equal(ends[0].terminal, true);
});

function fakePrimary(messages = [{ role: 'user', content: 'do the task' }]) {
  const listeners = new Set();
  const steers = [];
  return {
    messages,
    usage: { cost: 0, tokens: 0 },
    maxTurns: 25,
    currentTurn: 0,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    steer(p) {
      steers.push(p);
      return true;
    },
    async run() {},
    async emit(ev) {
      for (const fn of listeners) await fn(ev);
    },
    _listeners: listeners,
    steers,
  };
}

function fakeSupervisor(reply = '{"action":"none"}') {
  return {
    usage: { cost: 0, tokens: 0 },
    currentTurn: 0,
    messages: [],
    responseFormat: undefined,
    subscribe() {
      return () => {};
    },
    steer() {
      return false;
    },
    async run(input) {
      this.lastInput = input;
      return typeof reply === 'function' ? reply(input) : reply;
    },
  };
}

test('createCopilot validates primary and supervisor', () => {
  assert.throws(() => createCopilot({ primary: {}, supervisor: fakeSupervisor() }), /primary/);
  assert.throws(() => createCopilot({ primary: fakePrimary(), supervisor: {} }), /supervisor/);
});

test('start subscribes and returns an abort signal; stop unsubscribes', () => {
  const primary = fakePrimary();
  const copilot = createCopilot({ primary, supervisor: fakeSupervisor() });
  const signal = copilot.start();
  assert.ok(signal && typeof signal.aborted === 'boolean');
  assert.equal(primary._listeners.size, 1);
  copilot.stop();
  assert.equal(primary._listeners.size, 0);
});

test('start is idempotent', () => {
  const primary = fakePrimary();
  const copilot = createCopilot({ primary, supervisor: fakeSupervisor() });
  const s1 = copilot.start();
  const s2 = copilot.start();
  assert.equal(s1, s2);
  assert.equal(primary._listeners.size, 1);
});

test('aborting the consumer signal aborts the copilot signal', () => {
  const consumer = new AbortController();
  const primary = fakePrimary();
  const copilot = createCopilot({ primary, supervisor: fakeSupervisor(), signal: consumer.signal });
  const signal = copilot.start();
  assert.equal(signal.aborted, false);
  consumer.abort();
  assert.equal(signal.aborted, true);
});

test('extractGoal returns the last user message text (string or parts)', () => {
  assert.equal(extractGoal([{ role: 'user', content: 'hello world' }]), 'hello world');
  assert.equal(
    extractGoal([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: [{ type: 'text', text: 'parts goal' }, { type: 'image_url' }] },
    ]),
    'parts goal',
  );
  assert.equal(extractGoal([{ role: 'assistant', content: 'x' }]), '');
});

test('renderWindow formats turns with tool calls and results', () => {
  const win = [
    {
      content: 'thinking then acting',
      reasoning: '',
      toolCalls: [{ function: { name: 'Bash', arguments: '{}' } }],
      toolEvents: [{ tool_end: { tool_call_id: 'a1', name: 'Bash', duration_ms: 5, error: 'boom' } }],
      callSigs: ['Bash:{}'],
    },
  ];
  const out = renderWindow(win, 2000);
  assert.match(out, /\[tool_calls\] Bash/);
  assert.match(out, /Bash#a1/);
  assert.match(out, /ERROR boom/);
  assert.match(out, /thinking then acting/);
});

test('buildInput includes goal, trigger reasons, and trace', () => {
  const input = buildInput('reach the moon', ['toolError', 'everyNTurns'], [], 2000);
  assert.match(input, /GOAL: reach the moon/);
  assert.match(input, /TRIGGER: toolError, everyNTurns/);
  assert.match(input, /JSON object/);
});
