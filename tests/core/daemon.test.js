import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../src/core/logger.js';
import { createDaemon, createTimerSource } from '../../src/core/daemon.js';

function fakeAgent({ running = false } = {}) {
  let _running = running;
  const runs = [];
  const steers = [];
  return {
    get isRunning() {
      return _running;
    },
    setRunning(v) {
      _running = v;
    },
    async run(prompt, notify, opts) {
      runs.push({ prompt, notify, opts });
      return 'ran';
    },
    steer(prompt) {
      steers.push(prompt);
      return _running;
    },
    runs,
    steers,
  };
}

async function tick(ms = 10) {
  await new Promise((r) => setTimeout(r, ms));
}

test('createDaemon throws on a non-Agent-like agent', () => {
  assert.throws(() => createDaemon({ agent: {}, handler: () => {} }), /agent must be an Agent-like/);
});

test('createDaemon throws on a non-function handler', () => {
  assert.throws(() => createDaemon({ agent: fakeAgent(), handler: 123 }), /handler must be a function/);
});

test('start returns a signal and sets isRunning; stop clears it and aborts the signal', async () => {
  const daemon = createDaemon({ agent: fakeAgent(), handler: () => null });
  const sig = daemon.start();
  assert.ok(sig instanceof AbortSignal);
  assert.equal(daemon.isRunning, true);
  await daemon.stop();
  assert.equal(daemon.isRunning, false);
  assert.equal(sig.aborted, true);
});

test('start is idempotent', () => {
  const daemon = createDaemon({ agent: fakeAgent(), handler: () => null });
  const s1 = daemon.start();
  const s2 = daemon.start();
  assert.equal(s1, s2);
});

test('a pre-aborted consumer signal yields an aborted signal and does not start', () => {
  const ac = new AbortController();
  ac.abort();
  const daemon = createDaemon({ agent: fakeAgent(), handler: () => null, signal: ac.signal });
  const sig = daemon.start();
  assert.equal(sig.aborted, true);
  assert.equal(daemon.isRunning, false);
});

test('aborting the consumer signal stops the daemon', async () => {
  const ac = new AbortController();
  const daemon = createDaemon({ agent: fakeAgent(), handler: () => null, signal: ac.signal });
  daemon.start();
  assert.equal(daemon.isRunning, true);
  ac.abort();
  await tick();
  assert.equal(daemon.isRunning, false);
});

test('emit before start is a no-op', async () => {
  const agent = fakeAgent();
  let called = false;
  const daemon = createDaemon({
    agent,
    handler: () => {
      called = true;
    },
  });
  daemon.emit({ type: 'x' });
  await tick();
  assert.equal(called, false);
});

test('handler receives the event and a well-formed ctx', async () => {
  const agent = fakeAgent();
  let captured;
  const daemon = createDaemon({
    agent,
    handler: (event, ctx) => {
      captured = { event, ctx };
      return null;
    },
  });
  const sig = daemon.start();
  daemon.emit({ type: 'x', data: 7 });
  await tick();
  assert.equal(captured.event.type, 'x');
  assert.equal(captured.event.data, 7);
  assert.equal(typeof captured.event.receivedAt, 'number');
  assert.equal(captured.ctx.agent, agent);
  assert.equal(captured.ctx.isRunning, false);
  assert.equal(typeof captured.ctx.emit, 'function');
  assert.equal(captured.ctx.daemon.isRunning, true);
  assert.equal(captured.ctx.signal, sig);
  await daemon.stop();
});

test('dispatch is serialized in arrival order', async () => {
  const order = [];
  const daemon = createDaemon({
    agent: fakeAgent(),
    handler: async (e) => {
      order.push(`start:${e.type}`);
      await tick(5);
      order.push(`end:${e.type}`);
      return null;
    },
  });
  daemon.start();
  daemon.emit({ type: 'a' });
  daemon.emit({ type: 'b' });
  await tick(40);
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b']);
  await daemon.stop();
});

test('a throwing handler does not crash the daemon', async () => {
  const seen = [];
  const daemon = createDaemon({
    agent: fakeAgent(),
    handler: (e) => {
      if (e.type === 'boom') throw new Error('boom');
      seen.push(e.type);
      return null;
    },
  });
  daemon.start();
  daemon.emit({ type: 'boom' });
  daemon.emit({ type: 'ok' });
  await tick(20);
  assert.deepEqual(seen, ['ok']);
  await daemon.stop();
});

test('start runs sources and stop tears them down', async () => {
  const events = [];
  let started = 0;
  let stopped = 0;
  const source = {
    start(emit) {
      started++;
      emit({ type: 'from-source' });
    },
    stop() {
      stopped++;
    },
  };
  const daemon = createDaemon({
    agent: fakeAgent(),
    handler: (e) => {
      events.push(e.type);
      return null;
    },
    sources: [source],
  });
  daemon.start();
  await tick();
  assert.equal(started, 1);
  assert.deepEqual(events, ['from-source']);
  await daemon.stop();
  assert.equal(stopped, 1);
});

test('run action calls agent.run with a signal when idle', async () => {
  const agent = fakeAgent();
  const daemon = createDaemon({ agent, handler: (e) => ({ type: 'run', prompt: e.data }) });
  daemon.start();
  daemon.emit({ type: 'go', data: 'hello' });
  await tick();
  assert.equal(agent.runs.length, 1);
  assert.equal(agent.runs[0].prompt, 'hello');
  assert.ok(agent.runs[0].opts.signal instanceof AbortSignal);
  await daemon.stop();
});

test('steer action calls agent.steer while running', async () => {
  const agent = fakeAgent({ running: true });
  const daemon = createDaemon({ agent, handler: () => ({ type: 'steer', prompt: 'nudge' }) });
  daemon.start();
  daemon.emit({ type: 'go' });
  await tick();
  assert.deepEqual(agent.steers, ['nudge']);
  assert.equal(agent.runs.length, 0);
  await daemon.stop();
});

test('prompt action auto-routes: run when idle, steer when running', async () => {
  const agent = fakeAgent({ running: false });
  const daemon = createDaemon({ agent, handler: (e) => ({ type: 'prompt', text: e.data }) });
  daemon.start();
  daemon.emit({ type: 'go', data: 'first' });
  await tick();
  assert.equal(agent.runs.length, 1);
  assert.equal(agent.runs[0].prompt, 'first');
  agent.setRunning(true);
  daemon.emit({ type: 'go', data: 'second' });
  await tick();
  assert.deepEqual(agent.steers, ['second']);
  await daemon.stop();
});

test('abort action aborts the current run; a later run gets a fresh signal', async () => {
  const agent = fakeAgent();
  const daemon = createDaemon({
    agent,
    handler: (e) => (e.type === 'abort' ? { type: 'abort' } : { type: 'run', prompt: e.type }),
  });
  daemon.start();
  daemon.emit({ type: 'r1' });
  await tick();
  const sig1 = agent.runs[0].opts.signal;
  daemon.emit({ type: 'abort' });
  await tick();
  assert.equal(sig1.aborted, true);
  daemon.emit({ type: 'r2' });
  await tick();
  const sig2 = agent.runs[1].opts.signal;
  assert.equal(sig2.aborted, false);
  assert.notEqual(sig1, sig2);
  await daemon.stop();
});

test('onAction observes produced actions', async () => {
  const agent = fakeAgent();
  const seen = [];
  const daemon = createDaemon({
    agent,
    handler: () => ({ type: 'ignore' }),
    onAction: (action, event) => seen.push([action.type, event.type]),
  });
  daemon.start();
  daemon.emit({ type: 'go' });
  await tick();
  assert.deepEqual(seen, [['ignore', 'go']]);
  await daemon.stop();
});

test('an unknown action type is ignored without crashing', async () => {
  const agent = fakeAgent();
  const daemon = createDaemon({ agent, handler: () => ({ type: 'frobnicate' }) });
  daemon.start();
  daemon.emit({ type: 'go' });
  await tick();
  assert.equal(agent.runs.length, 0);
  assert.equal(agent.steers.length, 0);
  await daemon.stop();
});

test('queue backpressure warns once past the soft cap', async () => {
  const agent = fakeAgent();
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const daemon = createDaemon({
    agent,
    handler: async () => {
      if (first) {
        first = false;
        await gate;
      }
      return null;
    },
  });
  const warns = [];
  const origWarn = logger.warn;
  logger.warn = (m) => warns.push(m);
  try {
    daemon.start();
    daemon.emit({ type: 'blocker' });
    await tick();
    for (let i = 0; i < 1001; i++) daemon.emit({ type: 'flood', data: i });
    release();
    await tick(30);
    assert.ok(
      warns.some((m) => /queue exceeded/.test(m)),
      `expected a backpressure warning, got: ${JSON.stringify(warns)}`,
    );
  } finally {
    logger.warn = origWarn;
    await daemon.stop();
  }
});

test('createTimerSource validates its inputs', () => {
  assert.throws(() => createTimerSource({ intervalMs: 0, event: { type: 't' } }), /intervalMs/);
  assert.throws(() => createTimerSource({ intervalMs: 10 }), /event is required/);
});

test('createTimerSource emits immediately and on the interval, then stops cleanly', async () => {
  const emits = [];
  const src = createTimerSource({ intervalMs: 10, event: { type: 'tick' }, immediate: true });
  src.start((e) => emits.push(e));
  await tick(35);
  src.stop();
  const countAtStop = emits.length;
  await tick(30);
  assert.ok(countAtStop >= 2, `expected immediate + >=1 interval emit, got ${countAtStop}`);
  assert.equal(emits.length, countAtStop, 'no emits after stop');
  assert.equal(emits[0].type, 'tick');
});

test('createTimerSource drives a daemon run', async () => {
  const agent = fakeAgent();
  const daemon = createDaemon({
    agent,
    handler: () => ({ type: 'run', prompt: 'beat' }),
    sources: [createTimerSource({ intervalMs: 10, event: { type: 'tick' }, immediate: true })],
  });
  daemon.start();
  await tick(15);
  assert.ok(agent.runs.length >= 1);
  assert.equal(agent.runs[0].prompt, 'beat');
  await daemon.stop();
});
