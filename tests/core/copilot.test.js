import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';
import {
  createCopilot,
  extractGoal,
  renderWindow,
  buildInput,
  normalizeTriggers,
  buildReasons,
  parseDecision,
} from '../../src/core/copilot.js';

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

function ctxWith(over = {}) {
  return {
    turn: 1,
    terminal: false,
    recentTurns: [],
    lastTurn: { callSigs: [], hadError: false },
    usage: { cost: 0 },
    costSinceLast: 0,
    maxTurns: 25,
    hadError: false,
    ...over,
  };
}

test('normalizeTriggers applies defaults and honors toggles', () => {
  const t = normalizeTriggers();
  assert.equal(t.toolError, true);
  assert.deepEqual(t.repeatedCall, { times: 3 });
  assert.equal(t.costDelta, false);
  assert.deepEqual(t.everyNTurns, { n: 5 });
  assert.deepEqual(t.nearMaxTurns, { within: 2 });

  const off = normalizeTriggers({ toolError: false, everyNTurns: false });
  assert.equal(off.toolError, false);
  assert.equal(off.everyNTurns, false);

  const over = normalizeTriggers({ repeatedCall: { times: 2 }, costDelta: { threshold: 0.5 } });
  assert.deepEqual(over.repeatedCall, { times: 2 });
  assert.deepEqual(over.costDelta, { threshold: 0.5 });
});

test('buildReasons fires toolError, everyNTurns, nearMaxTurns, costDelta', () => {
  const t = normalizeTriggers({ costDelta: { threshold: 0.1 } });
  assert.ok(buildReasons(ctxWith({ hadError: true }), t).includes('toolError'));
  assert.ok(buildReasons(ctxWith({ turn: 5 }), t).includes('everyNTurns'));
  assert.ok(buildReasons(ctxWith({ turn: 24, maxTurns: 25 }), t).includes('nearMaxTurns'));
  assert.ok(buildReasons(ctxWith({ costSinceLast: 0.2 }), t).includes('costDelta'));
  assert.equal(buildReasons(ctxWith({ turn: 2 }), t).length, 0);
});

test('buildReasons fires repeatedCall from window counts', () => {
  const t = normalizeTriggers({ everyNTurns: false, nearMaxTurns: false });
  const recentTurns = [{ callSigs: ['Bash:{}'] }, { callSigs: ['Bash:{}'] }, { callSigs: ['Bash:{}'] }];
  assert.ok(buildReasons(ctxWith({ recentTurns }), t).includes('repeatedCall'));
});

test('buildReasons supports custom predicates (boolean and string)', () => {
  const t = normalizeTriggers({
    toolError: false,
    everyNTurns: false,
    nearMaxTurns: false,
    custom: [() => true, () => 'budget-rule', () => false],
  });
  const r = buildReasons(ctxWith({ turn: 2 }), t);
  assert.ok(r.includes('custom'));
  assert.ok(r.includes('budget-rule'));
});

test('buildReasons swallows throwing custom predicate', () => {
  const t = normalizeTriggers({
    toolError: false,
    everyNTurns: false,
    nearMaxTurns: false,
    custom: [
      () => {
        throw new Error('bad');
      },
    ],
  });
  assert.equal(buildReasons(ctxWith({ turn: 2 }), t).length, 0);
});

const flush = () => new Promise((r) => setTimeout(r, 15));

test('parseDecision coerces malformed/unknown to none, validates steer prompt', () => {
  assert.deepEqual(parseDecision('{"action":"none"}').action, 'none');
  assert.equal(parseDecision('not json').action, 'none');
  assert.equal(parseDecision('{"action":"frobnicate"}').action, 'none');
  assert.equal(parseDecision('{"action":"steer"}').action, 'none'); // missing prompt
  const steer = parseDecision('{"action":"steer","prompt":"focus on X"}');
  assert.equal(steer.action, 'steer');
  assert.equal(steer.prompt, 'focus on X');
  assert.equal(parseDecision('garbage {"action":"abort"} trailing').action, 'abort');
});

test('gate closed => supervisor never called', async () => {
  const primary = fakePrimary();
  const supervisor = fakeSupervisor('{"action":"steer","prompt":"no"}');
  const copilot = createCopilot({
    primary,
    supervisor,
    triggers: { toolError: false, everyNTurns: false, nearMaxTurns: false, repeatedCall: false },
  });
  copilot.start();
  await primary.emit({ turn_end: { turn: 2, terminal: false } });
  await flush();
  assert.equal(supervisor.lastInput, undefined);
  assert.deepEqual(primary.steers, []);
});

test('toolError trigger => supervisor steers the primary', async () => {
  const primary = fakePrimary();
  const supervisor = fakeSupervisor('{"action":"steer","prompt":"retry with sudo"}');
  const decisions = [];
  const copilot = createCopilot({ primary, supervisor, onDecision: (d) => decisions.push(d) });
  copilot.start();
  await primary.emit({ tool_end: { tool_call_id: 'a1', name: 'Bash', duration_ms: 3, error: 'denied' } });
  await primary.emit({ turn_end: { turn: 1, terminal: false } });
  await flush();
  assert.deepEqual(primary.steers, ['retry with sudo']);
  assert.equal(decisions[0].action, 'steer');
  assert.ok(decisions[0].triggers.includes('toolError'));
  assert.match(supervisor.lastInput, /GOAL: do the task/);
});

test('abort decision aborts the run signal', async () => {
  const primary = fakePrimary();
  const supervisor = fakeSupervisor('{"action":"abort","reason":"unrecoverable"}');
  const copilot = createCopilot({ primary, supervisor });
  const signal = copilot.start();
  await primary.emit({ tool_end: { tool_call_id: 'a1', name: 'Bash', duration_ms: 3, error: 'x' } });
  await primary.emit({ turn_end: { turn: 1, terminal: false } });
  await flush();
  assert.equal(signal.aborted, true);
});

test('supervisor throw is best-effort: run unaffected, decision coerced to none', async () => {
  const primary = fakePrimary();
  const supervisor = fakeSupervisor(() => {
    throw new Error('supervisor down');
  });
  const decisions = [];
  const copilot = createCopilot({ primary, supervisor, onDecision: (d) => decisions.push(d) });
  copilot.start();
  await primary.emit({ tool_end: { tool_call_id: 'a1', name: 'Bash', duration_ms: 3, error: 'x' } });
  await primary.emit({ turn_end: { turn: 1, terminal: false } });
  await flush();
  assert.deepEqual(primary.steers, []);
  assert.equal(decisions[0].action, 'none');
});

test('overlap guard: only one evaluation while one is in flight', async () => {
  const primary = fakePrimary();
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const supervisor = {
    usage: { cost: 0 },
    currentTurn: 0,
    messages: [],
    responseFormat: undefined,
    subscribe: () => () => {},
    steer: () => false,
    async run() {
      calls++;
      await gate;
      return '{"action":"none"}';
    },
  };
  const copilot = createCopilot({ primary, supervisor });
  copilot.start();
  await primary.emit({ tool_end: { tool_call_id: 'a1', name: 'B', duration_ms: 1, error: 'x' } });
  await primary.emit({ turn_end: { turn: 1, terminal: false } });
  await primary.emit({ tool_end: { tool_call_id: 'a2', name: 'B', duration_ms: 1, error: 'x' } });
  await primary.emit({ turn_end: { turn: 2, terminal: false } });
  await flush();
  assert.equal(calls, 1, 'second evaluation skipped while first in flight');
  release();
  await flush();
});
