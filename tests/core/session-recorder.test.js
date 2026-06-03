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
  r.recordAssistant(1, {
    content: 'calling tool',
    reasoning: 'thinking',
    tool_calls: [{ id: 'c1', function: { name: 'Echo' } }],
  });
  r.record({ tool_start: { tool_call_id: 'c1', name: 'Echo', input: { msg: 'hi' } } }, 1);
  r.record({ tool_end: { tool_call_id: 'c1', name: 'Echo', duration_ms: 5, output: 'hi' } }, 1);
  r.recordAssistant(2, { content: 'final' });
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
    r.record({ tool_end: { tool_call_id: 'x', name: 'X', duration_ms: 1, output: 'y' } }, 1);
    r.recordAssistant(1, { content: 'late' });
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

test('full level writes request and response records', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'full', model: 'm' });
  r.request(1, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  r.response(1, { choices: [{ message: { content: 'hello' } }], usage: { cost: 1 } });
  await r.close();

  const recs = readRecords(dir);
  const req = recs.find((x) => x.type === 'request');
  const resp = recs.find((x) => x.type === 'response');
  assert.ok(req, 'expected a request record at level full');
  assert.equal(req.turn, 1);
  assert.deepEqual(req.payload.messages, [{ role: 'user', content: 'hi' }]);
  assert.ok(resp, 'expected a response record at level full');
  assert.equal(resp.raw.choices[0].message.content, 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('snapshots level does not write request/response records', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'snapshots' });
  r.request(1, { messages: [] });
  r.response(1, { choices: [] });
  await r.close();
  const recs = readRecords(dir);
  assert.ok(!recs.some((x) => x.type === 'request'), 'request must be gated to full');
  assert.ok(!recs.some((x) => x.type === 'response'), 'response must be gated to full');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('request record deep-copies the payload at call time', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({ dir, level: 'full' });
  const payload = { messages: [{ role: 'user', content: 'original' }] };
  r.request(2, payload);
  payload.messages[0].content = 'mutated after record';
  await r.close();
  const recs = readRecords(dir);
  const req = recs.find((x) => x.type === 'request');
  assert.equal(req.payload.messages[0].content, 'original', 'request must snapshot, not alias');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redact hook scrubs records before write', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({
    dir,
    level: 'full',
    redact: (rec) => (rec.type === 'request' ? { ...rec, payload: '[REDACTED]' } : rec),
  });
  r.request(1, { messages: [{ role: 'user', content: 'secret prompt' }] });
  r.response(1, { choices: [{ message: { content: 'ok' } }] });
  await r.close();
  const recs = readRecords(dir);
  const req = recs.find((x) => x.type === 'request');
  const resp = recs.find((x) => x.type === 'response');
  assert.equal(req.payload, '[REDACTED]', 'request payload must be redacted');
  assert.equal(resp.raw.choices[0].message.content, 'ok', 'non-matching records pass through');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redact returning falsy drops the record; a throwing redact drops it and keeps recording alive', async () => {
  const dir = tmpDir();
  const r = createSessionRecorder({
    dir,
    level: 'full',
    redact: (rec) => {
      if (rec.type === 'request') return null; // drop
      if (rec.type === 'response') throw new Error('redact boom'); // drop, stay alive
      return rec;
    },
  });
  r.request(1, { messages: [] });
  r.response(1, { choices: [] });
  r.recordAssistant(2, { content: 'survives' });
  await r.close();
  const recs = readRecords(dir);
  assert.ok(!recs.some((x) => x.type === 'request'), 'falsy redact drops record');
  assert.ok(!recs.some((x) => x.type === 'response'), 'throwing redact drops record');
  assert.ok(
    recs.some((x) => x.type === 'assistant' && x.content === 'survives'),
    'recording stays alive after a redact throw',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
