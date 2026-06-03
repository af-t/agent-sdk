import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Recording } from '../../src/core/recording.js';

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recload-'));
  const file = path.join(dir, 'session-fixture.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

test('load parses meta, events, and snapshots and skips malformed lines', async () => {
  const { dir, file } = writeFixture([
    { t: 'x', type: 'session_start', id: 's1', level: 'snapshots', model: 'm' },
    { t: 'x', type: 'tool_calls', turn: 1, calls: [{ id: 'c1', name: 'Echo' }] },
    {
      t: 'x',
      type: 'turn_snapshot',
      turn: 1,
      messages: [{ role: 'user', content: 'hi' }],
      usage: { cost: 1, tokens: 2 },
    },
    { t: 'x', type: 'session_end', reason: 'closed' },
  ]);
  fs.appendFileSync(file, 'not json\n');

  const rec = await Recording.load(file);
  assert.equal(rec.id, 's1');
  assert.equal(rec.level, 'snapshots');
  assert.equal(rec.model, 'm');
  assert.equal(rec.events.length, 1);
  assert.equal(rec.events[0].type, 'tool_calls');
  assert.equal(rec.snapshots.length, 1);
  assert.deepEqual(rec.snapshotAt(1).usage, { cost: 1, tokens: 2 });
  assert.equal(rec.snapshotAt(99), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('forkAt seeds a new independent Agent from the snapshot', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const { dir, file } = writeFixture([
    { t: 'x', type: 'session_start', id: 's1', level: 'snapshots', model: 'm' },
    {
      t: 'x',
      type: 'turn_snapshot',
      turn: 2,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: 'hello' },
      ],
      usage: { cost: 0.3, tokens: 7 },
    },
  ]);

  const rec = await Recording.load(file);
  const parent = new Agent({ apiKey: 'sk-test', model: 'parent-model' });
  parent.use({
    name: 'Echo',
    description: 'echo',
    input_schema: { type: 'object', properties: {} },
    execute: async () => 'x',
  });

  const child = parent.forkAt(rec, 2);
  assert.notEqual(child, parent);
  assert.equal(child.messages.length, 2);
  assert.equal(child.messages[1].content, 'hello');
  assert.deepEqual(child.usage, { cost: 0.3, tokens: 7 });
  assert.equal(child.tools, parent.tools, 'fork shares the parent tool registry');

  child.messages.push({ role: 'user', content: 'new branch' });
  assert.equal(parent.messages.length, 0, 'forking must not push into the parent');
  child.messages[0].content[0].text = 'mutated';
  assert.equal(
    rec.snapshotAt(2).messages[0].content[0].text,
    'hi',
    'forking must deep-clone, not alias the recording snapshot',
  );

  assert.throws(() => parent.forkAt(rec, 99), /No snapshot/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderTrace reconstructs the human trace from recorded events', async () => {
  const { dir, file } = writeFixture([
    { t: 'x', type: 'session_start', id: 's1', level: 'events', model: 'm' },
    { t: 'x', type: 'assistant', turn: 1, content: 'I will read the file', reasoning: 'thinking about the task' },
    { t: 'x', type: 'tool_calls', turn: 1, calls: [{ id: 'abc', name: 'Read' }] },
    { t: 'x', type: 'tool_start', turn: 1, tool_call_id: 'abc', name: 'Read', input: { file_path: '/x.txt' } },
    { t: 'x', type: 'tool_end', turn: 1, tool_call_id: 'abc', name: 'Read', duration_ms: 12, output: 'file body' },
    { t: 'x', type: 'assistant', turn: 2, content: 'final answer', reasoning: '' },
  ]);

  const rec = await Recording.load(file);
  const trace = rec.renderTrace();
  assert.match(trace, /=== turn 1 ===/);
  assert.match(trace, /\[reasoning\]\nthinking about the task/);
  assert.match(trace, /\[assistant\]\nI will read the file/);
  assert.match(trace, /\[tool_calls\] Read/);
  assert.match(trace, /-> Read#abc start: \{"file_path":"\/x.txt"\}/);
  assert.match(trace, /-> Read#abc end \(12ms\): file body/);
  assert.match(trace, /=== turn 2 ===/);
  assert.match(trace, /\[assistant\]\nfinal answer/);
  fs.rmSync(dir, { recursive: true, force: true });
});
