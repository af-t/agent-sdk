import { test } from 'node:test';
/* eslint-disable prefer-const */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTraceWriter } from '../../src/core/trace-writer.js';
import { createTestTempDir } from '../support/temp.js';

function createTestTraceWriter(t) {
  let closePromise;
  let writer;
  const close = () => (closePromise ??= writer?.close());
  t.after(close);
  const dir = createTestTempDir(t, 'trace-test-');
  writer = createTraceWriter(path.join(dir, 'trace.log'));
  return { close, logPath: path.join(dir, 'trace.log'), writer };
}

test('writes turn header, reasoning, assistant text, and tool entries', async (t) => {
  const { close, logPath, writer: w } = createTestTraceWriter(t);
  await w.notify({ reasoning: 'thinking about the task' });
  await w.notify({ content: 'I will read the file' });
  await w.notify({ tool_calls: [{ id: 'abc', function: { name: 'readFile', arguments: '{}' } }] });
  await w.notify({ tool_start: { tool_call_id: 'abc', name: 'readFile', input: { path: '/x.txt' } } });
  await w.notify({ tool_end: { tool_call_id: 'abc', name: 'readFile', duration_ms: 12, output: 'file body' } });
  await close();

  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /=== turn 1 ===/);
  assert.match(out, /\[reasoning\]\nthinking about the task/);
  assert.match(out, /\[assistant\]\nI will read the file/);
  assert.match(out, /\[tool_calls\] readFile/);
  assert.match(out, /-> readFile#abc start: \{"path":"\/x.txt"\}/);
  assert.match(out, /-> readFile#abc end \(12ms\): file body/);
});

test('flushes a final turn with no tool_calls on close', async (t) => {
  const { close, logPath, writer: w } = createTestTraceWriter(t);
  await w.notify({ content: 'final answer' });
  await close();
  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /=== turn 1 ===/);
  assert.match(out, /\[assistant\]\nfinal answer/);
});

test('records tool errors and truncates oversized output', async (t) => {
  let closePromise;
  let w;
  const close = () => (closePromise ??= w?.close());
  t.after(close);
  const dir = createTestTempDir(t, 'trace-test-');
  const logPath = path.join(dir, 'trace.log');
  w = createTraceWriter(logPath, { toolOutputCap: 20 });
  await w.notify({ tool_calls: [{ id: 'e1', function: { name: 'Bash' } }] });
  await w.notify({ tool_end: { tool_call_id: 'e1', name: 'Bash', duration_ms: 5, error: 'boom' } });
  await w.notify({ tool_calls: [{ id: 'big', function: { name: 'readFile' } }] });
  await w.notify({ tool_end: { tool_call_id: 'big', name: 'readFile', duration_ms: 5, output: 'x'.repeat(500) } });
  await close();
  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /-> Bash#e1 end \(5ms\): ERROR boom/);
  assert.ok(!out.includes('x'.repeat(500)), 'oversized output should be truncated');
});
