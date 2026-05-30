import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTraceWriter } from '../../src/core/trace-writer.js';

function tmpLog() {
  return path.join(os.tmpdir(), `trace-test-${Math.random().toString(36).slice(2)}.log`);
}

test('writes turn header, reasoning, assistant text, and tool entries', async () => {
  const logPath = tmpLog();
  const w = createTraceWriter(logPath);
  await w.notify({ reasoning: 'thinking about the task' });
  await w.notify({ content: 'I will read the file' });
  await w.notify({ tool_calls: [{ id: 'abc', function: { name: 'Read', arguments: '{}' } }] });
  await w.notify({ tool_start: { tool_call_id: 'abc', name: 'Read', input: { file_path: '/x.txt' } } });
  await w.notify({ tool_end: { tool_call_id: 'abc', name: 'Read', duration_ms: 12, output: 'file body' } });
  await w.close();

  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /=== turn 1 ===/);
  assert.match(out, /\[reasoning\]\nthinking about the task/);
  assert.match(out, /\[assistant\]\nI will read the file/);
  assert.match(out, /\[tool_calls\] Read/);
  assert.match(out, /-> Read#abc start: \{"file_path":"\/x.txt"\}/);
  assert.match(out, /-> Read#abc end \(12ms\): file body/);
  fs.unlinkSync(logPath);
});

test('flushes a final turn with no tool_calls on close', async () => {
  const logPath = tmpLog();
  const w = createTraceWriter(logPath);
  await w.notify({ content: 'final answer' });
  await w.close();
  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /=== turn 1 ===/);
  assert.match(out, /\[assistant\]\nfinal answer/);
  fs.unlinkSync(logPath);
});

test('records tool errors and truncates oversized output', async () => {
  const logPath = tmpLog();
  const w = createTraceWriter(logPath, { toolOutputCap: 20 });
  await w.notify({ tool_calls: [{ id: 'e1', function: { name: 'Bash' } }] });
  await w.notify({ tool_end: { tool_call_id: 'e1', name: 'Bash', duration_ms: 5, error: 'boom' } });
  await w.notify({ tool_calls: [{ id: 'big', function: { name: 'Read' } }] });
  await w.notify({ tool_end: { tool_call_id: 'big', name: 'Read', duration_ms: 5, output: 'x'.repeat(500) } });
  await w.close();
  const out = fs.readFileSync(logPath, 'utf8');
  assert.match(out, /-> Bash#e1 end \(5ms\): ERROR boom/);
  assert.ok(!out.includes('x'.repeat(500)), 'oversized output should be truncated');
  fs.unlinkSync(logPath);
});
