import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';
import * as wakeup from '../../src/tools/system/wakeup.js';

test('Wakeup name and schema', () => {
  assert.equal(wakeup.name, 'Wakeup');
  assert.ok(wakeup.input_schema.properties.delay_ms);
  assert.ok(wakeup.input_schema.properties.at);
  assert.ok(wakeup.input_schema.properties.watch);
  assert.ok(wakeup.input_schema.properties.tail_bytes);
  assert.ok(wakeup.input_schema.properties.reason);
  assert.ok(wakeup.input_schema.properties.prompt);
});

test('Wakeup rejects when neither delay_ms nor at is provided', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(wakeup.execute({}, { agent }), /delay_ms.*at/);
});

test('Wakeup rejects when both delay_ms and at are provided', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(
    wakeup.execute({ delay_ms: 100, at: new Date().toISOString() }, { agent }),
    /mutually exclusive/i,
  );
});

test('Wakeup rejects delay_ms > 2^31 - 1', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(wakeup.execute({ delay_ms: 2 ** 31 }, { agent }), /too large/i);
});

test('registers a non-blocking timer and returns immediately', async () => {
  const agent = new Agent({ apiKey: 'x' });
  const before = Date.now();
  const out = await wakeup.execute({ delay_ms: 5000 }, { agent });
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 200, `expected immediate return, took ${elapsed}ms`);
  assert.match(out, /bg-[0-9a-f]{5}/);
  const timers = [...agent.backgroundJobs.values()].filter((j) => j.kind === 'timer');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].watch.length, 0);
});

test('stores watch ids and tailBytes on the timer job', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await wakeup.execute({ delay_ms: 5000, watch: ['bg-zzzzz'], tail_bytes: 256 }, { agent });
  const job = [...agent.backgroundJobs.values()].find((j) => j.kind === 'timer');
  assert.deepEqual(job.watch, ['bg-zzzzz']);
  assert.equal(job.tailBytes, 256);
});

test('requires ctx.agent', async () => {
  await assert.rejects(() => wakeup.execute({ delay_ms: 100 }, {}), /agent/i);
});

test('echoes reason in the return message and stores reason/prompt on the timer job', async () => {
  const agent = new Agent({ apiKey: 'x' });
  const out = await wakeup.execute({ delay_ms: 5000, reason: 'pace check-in', prompt: 'resume the task' }, { agent });
  assert.match(out, /reason: pace check-in/);
  const job = [...agent.backgroundJobs.values()].find((j) => j.kind === 'timer');
  assert.equal(job.reason, 'pace check-in');
  assert.equal(job.prompt, 'resume the task');
});
