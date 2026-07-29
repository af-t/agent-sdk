import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../../src/agent/agent.js';
import { scheduleWakeup } from '../../../src/tools/system/schedule-wakeup.js';

test('scheduleWakeup exposes its strict timer schema', () => {
  assert.equal(scheduleWakeup.name, 'scheduleWakeup');
  assert.equal(scheduleWakeup.inputSchema.additionalProperties, false);
  assert.ok(scheduleWakeup.inputSchema.properties.delayMs);
  assert.ok(scheduleWakeup.inputSchema.properties.at);
  assert.ok(scheduleWakeup.inputSchema.properties.watch);
  assert.ok(scheduleWakeup.inputSchema.properties.tailBytes);
  assert.ok(scheduleWakeup.inputSchema.properties.reason);
  assert.ok(scheduleWakeup.inputSchema.properties.prompt);
});

test('scheduleWakeup rejects when neither delayMs nor at is provided', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(scheduleWakeup.execute({}, { agent }), /delayMs.*at/);
});

test('scheduleWakeup rejects when both delayMs and at are provided', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(
    scheduleWakeup.execute({ delayMs: 100, at: new Date().toISOString() }, { agent }),
    /mutually exclusive/i,
  );
});

test('scheduleWakeup rejects delayMs above 2^31 - 1', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(scheduleWakeup.execute({ delayMs: 2 ** 31 }, { agent }), /too large/i);
});

test('registers a non-blocking timer and returns immediately', async () => {
  const agent = new Agent({ apiKey: 'x' });
  const before = Date.now();
  const out = await scheduleWakeup.execute({ delayMs: 5000 }, { agent });
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 200, `expected immediate return, took ${elapsed}ms`);
  assert.match(out, /bg-[0-9a-f]{5}/);
  const timers = agent.backgroundJobs.list().filter((j) => j.kind === 'timer');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].watch.length, 0);
});

test('stores watch ids and tailBytes on the timer job', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await scheduleWakeup.execute({ delayMs: 5000, watch: ['bg-zzzzz'], tailBytes: 256 }, { agent });
  const job = agent.backgroundJobs.list().find((j) => j.kind === 'timer');
  assert.deepEqual(job.watch, ['bg-zzzzz']);
  assert.equal(job.tailBytes, 256);
});

test('requires ctx.agent', async () => {
  await assert.rejects(() => scheduleWakeup.execute({ delayMs: 100 }, {}), /agent/i);
});

test('echoes reason in the return message and stores reason/prompt on the timer job', async () => {
  const agent = new Agent({ apiKey: 'x' });
  const out = await scheduleWakeup.execute(
    { delayMs: 5000, reason: 'pace check-in', prompt: 'resume the task' },
    { agent },
  );
  assert.match(out, /reason: pace check-in/);
  const job = agent.backgroundJobs.list().find((j) => j.kind === 'timer');
  assert.equal(job.reason, 'pace check-in');
  assert.equal(job.prompt, 'resume the task');
});
