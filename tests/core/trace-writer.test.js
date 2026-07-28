import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTraceWriter } from '../../src/core/trace-writer.js';
import { createTestTempDir } from '../support/temp.js';

function createTestTraceWriter(t) {
  const dir = createTestTempDir(t, 'trace-test-');
  const writer = createTraceWriter(path.join(dir, 'trace.log'));
  let closePromise;
  const close = () => (closePromise ??= writer.close());
  t.after(close);
  return { close, logPath: path.join(dir, 'trace.log'), writer };
}

test('writes turn header, reasoning, assistant text, and tool entries', async (t) => {
  const { close, logPath, writer: w } = createTestTraceWriter(t);
  await w.notify({ reasoning: 'thinking about the task' });
  await w.notify({ content: 'I will read the file' });
  await w.notify({ tool_calls: [{ id: 'abc', function: { name: 'Read', arguments: '{}' } }] });
  await w.notify({ tool_start: { tool_call_id: 'abc', name: 'Read', input: { file_path: '/x.txt' } } });
  await w.notify({ tool_end: { tool_call_id: 'abc', name: 'Read', duration_ms: 12, output: 'file body' } });
  await close();

  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /=== turn 1 ===/);
  assert.match(out, /\[reasoning\]\nthinking about the task/);
  assert.match(out, /\[assistant\]\nI will read the file/);
  assert.match(out, /\[tool_calls\] Read/);
  assert.match(out, /-> Read#abc start: \{"file_path":"\/x.txt"\}/);
  assert.match(out, /-> Read#abc end \(12ms\): file body/);
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
  const dir = createTestTempDir(t, 'trace-test-');
  const logPath = path.join(dir, 'trace.log');
  const w = createTraceWriter(logPath, { toolOutputCap: 20 });
  let closePromise;
  const close = () => (closePromise ??= w.close());
  t.after(close);
  await w.notify({ tool_calls: [{ id: 'e1', function: { name: 'Bash' } }] });
  await w.notify({ tool_end: { tool_call_id: 'e1', name: 'Bash', duration_ms: 5, error: 'boom' } });
  await w.notify({ tool_calls: [{ id: 'big', function: { name: 'Read' } }] });
  await w.notify({ tool_end: { tool_call_id: 'big', name: 'Read', duration_ms: 5, output: 'x'.repeat(500) } });
  await close();
  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /-> Bash#e1 end \(5ms\): ERROR boom/);
  assert.ok(!out.includes('x'.repeat(500)), 'oversized output should be truncated');
});
