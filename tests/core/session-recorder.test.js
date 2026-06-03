import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSessionRecorder } from '../../src/core/session-recorder.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-'));
}

function readRecords(dir) {
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return fs
    .readFileSync(path.join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

test('writes session_start, event records, and session_end', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'events', model: 'm' });
  r.record({ reasoning: 'thinking' }, 1);
  r.record({ content: 'calling tool' }, 1);
  r.record({ tool_calls: [{ id: 'c1', function: { name: 'Echo' } }] }, 1);
  r.record({ tool_start: { tool_call_id: 'c1', name: 'Echo', input: { msg: 'hi' } } }, 1);
  r.record({ tool_end: { tool_call_id: 'c1', name: 'Echo', duration_ms: 5, output: 'hi' } }, 1);
  r.record({ content: 'final' }, 2);
  await r.close();

  const recs = readRecords(dir);
  const types = recs.map((x) => x.type);
  assert.equal(recs[0].type, 'session_start');
  assert.equal(recs[0].model, 'm');
  assert.ok(types.includes('tool_calls'), 'expected tool_calls record');
  assert.ok(types.includes('tool_start'), 'expected tool_start record');
  assert.ok(types.includes('tool_end'), 'expected tool_end record');
  const assistantRecs = recs.filter((x) => x.type === 'assistant');
  assert.equal(assistantRecs[0].content, 'calling tool');
  assert.equal(assistantRecs[0].turn, 1);
  assert.equal(assistantRecs[1].content, 'final');
  assert.equal(assistantRecs[1].turn, 2);
  assert.equal(recs[recs.length - 1].type, 'session_end');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writes turn_snapshot only at level snapshots and deep-copies state', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'snapshots' });
  const messages = [{ role: 'user', content: 'hi' }];
  r.snapshot(1, messages, { cost: 0.5, tokens: 10 });
  messages.push({ role: 'assistant', content: 'mutated after snapshot' });
  await r.close();

  const recs = readRecords(dir);
  const snap = recs.find((x) => x.type === 'turn_snapshot');
  assert.ok(snap);
  assert.equal(snap.turn, 1);
  assert.equal(snap.messages.length, 1, 'snapshot must be a deep copy taken at call time');
  assert.deepEqual(snap.usage, { cost: 0.5, tokens: 10 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('events level does not write snapshots', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'events' });
  r.snapshot(1, [{ role: 'user', content: 'hi' }], { cost: 0, tokens: 0 });
  await r.close();
  const recs = readRecords(dir);
  assert.ok(!recs.some((x) => x.type === 'turn_snapshot'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('operations after close do not throw', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'snapshots' });
  await r.close();
  assert.doesNotThrow(() => {
    r.record({ content: 'late' }, 1);
    r.snapshot(2, [{ role: 'user', content: 'x' }], { cost: 0, tokens: 0 });
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('records steer events', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'events' });
  r.record({ steer_applied: { count: 2 } }, 3);
  await r.close();
  const recs = readRecords(dir);
  const steer = recs.find((x) => x.type === 'steer');
  assert.ok(steer, 'expected a steer record');
  assert.equal(steer.count, 2);
  assert.equal(steer.turn, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unknown level falls back to snapshots', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'bogus' });
  r.snapshot(1, [{ role: 'user', content: 'x' }], { cost: 0, tokens: 0 });
  await r.close();
  const recs = readRecords(dir);
  assert.ok(
    recs.some((x) => x.type === 'turn_snapshot'),
    'bogus level should behave like snapshots',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
