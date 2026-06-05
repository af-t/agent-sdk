import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logger } from '../../src/core/logger.js';
import Agent from '../../src/core/agent.js';
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
