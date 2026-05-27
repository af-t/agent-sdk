import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import createAgent from '../../src/index.js';
import * as remind from '../../src/tools/system/remind.js';

test('Remind name and schema', () => {
  assert.equal(remind.name, 'Remind');
  assert.ok(remind.input_schema.properties.wait_ms);
  assert.ok(remind.input_schema.properties.until);
  assert.ok(remind.input_schema.properties.watch);
  assert.ok(remind.input_schema.properties.tail_bytes);
});

test('Remind wait_ms blocks for at least N milliseconds', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  const t0 = Date.now();
  const out = await remind.execute({ wait_ms: 100 }, { agent, signal: new AbortController().signal });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 95, `expected >=95ms, got ${elapsed}`);
  assert.match(out, /Waited \d+ms/);
});

test('Remind until resolves at the target time', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  const target = new Date(Date.now() + 150).toISOString();
  const t0 = Date.now();
  await remind.execute({ until: target }, { agent, signal: new AbortController().signal });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 130, `expected >=130ms, got ${elapsed}`);
});

test('Remind rejects when neither wait_ms nor until is provided', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  await assert.rejects(remind.execute({}, { agent, signal: new AbortController().signal }), /wait_ms.*until/);
});

test('Remind rejects when both wait_ms and until are provided', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  await assert.rejects(
    remind.execute({ wait_ms: 100, until: new Date().toISOString() }, { agent, signal: new AbortController().signal }),
    /mutually exclusive/i,
  );
});

test('Remind rejects wait_ms > 2^31 - 1', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  await assert.rejects(
    remind.execute({ wait_ms: 2 ** 31 }, { agent, signal: new AbortController().signal }),
    /too large/i,
  );
});

test('Remind aborts on signal', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(remind.execute({ wait_ms: 5000 }, { agent, signal: ac.signal }), /aborted/i);
});

test('Remind watch short-circuits when a bg job exits', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-'));
  const logPath = path.join(tmp, 'x.log');
  fs.writeFileSync(logPath, 'partial output\n');
  agent.backgroundJobs.set('bg-test', {
    id: 'bg-test',
    kind: 'bash',
    logPath,
    startedAt: Date.now(),
    status: 'running',
  });

  const t0 = Date.now();
  setTimeout(() => {
    const job = agent.backgroundJobs.get('bg-test');
    job.status = 'exited';
    job.exitCode = 0;
    job.endedAt = Date.now();
    fs.appendFileSync(logPath, 'final line\n');
    agent._fireBackgroundExit({
      id: 'bg-test',
      kind: 'bash',
      exitCode: 0,
      durationMs: 50,
      status: 'exited',
      logPath,
    });
  }, 50);

  const out = await remind.execute(
    { wait_ms: 5000, watch: ['bg-test'] },
    { agent, signal: new AbortController().signal },
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200, `expected short-circuit, got ${elapsed}ms`);
  assert.match(out, /bg-test/);
  assert.match(out, /partial output/);
  fs.rmSync(tmp, { recursive: true });
});

test('Remind watch with already-exited job returns immediately', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  agent.backgroundJobs.set('bg-done', {
    id: 'bg-done',
    kind: 'bash',
    logPath: '/dev/null',
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
    status: 'exited',
    exitCode: 0,
  });
  const t0 = Date.now();
  const out = await remind.execute(
    { wait_ms: 5000, watch: ['bg-done'] },
    { agent, signal: new AbortController().signal },
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `expected immediate, got ${elapsed}ms`);
  assert.match(out, /bg-done/);
});
