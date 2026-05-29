import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';
import * as remind from '../../src/tools/system/remind.js';

test('Remind name and schema', () => {
  assert.equal(remind.name, 'Remind');
  assert.ok(remind.input_schema.properties.wait_ms);
  assert.ok(remind.input_schema.properties.until);
  assert.ok(remind.input_schema.properties.watch);
  assert.ok(remind.input_schema.properties.tail_bytes);
});

test('Remind rejects when neither wait_ms nor until is provided', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(remind.execute({}, { agent }), /wait_ms.*until/);
});

test('Remind rejects when both wait_ms and until are provided', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(
    remind.execute({ wait_ms: 100, until: new Date().toISOString() }, { agent }),
    /mutually exclusive/i,
  );
});

test('Remind rejects wait_ms > 2^31 - 1', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await assert.rejects(remind.execute({ wait_ms: 2 ** 31 }, { agent }), /too large/i);
});

test('registers a non-blocking timer and returns immediately', async () => {
  const agent = new Agent({ apiKey: 'x' });
  const before = Date.now();
  const out = await remind.execute({ wait_ms: 5000 }, { agent });
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 200, `expected immediate return, took ${elapsed}ms`);
  assert.match(out, /bg-[0-9a-f]{5}/);
  const timers = [...agent.backgroundJobs.values()].filter((j) => j.kind === 'timer');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].watch.length, 0);
});

test('stores watch ids and tailBytes on the timer job', async () => {
  const agent = new Agent({ apiKey: 'x' });
  await remind.execute({ wait_ms: 5000, watch: ['bg-zzzzz'], tail_bytes: 256 }, { agent });
  const job = [...agent.backgroundJobs.values()].find((j) => j.kind === 'timer');
  assert.deepEqual(job.watch, ['bg-zzzzz']);
  assert.equal(job.tailBytes, 256);
});

test('requires ctx.agent', async () => {
  await assert.rejects(() => remind.execute({ wait_ms: 100 }, {}), /agent/i);
});
