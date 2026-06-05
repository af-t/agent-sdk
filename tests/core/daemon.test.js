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
