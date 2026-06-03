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
        { role: 'user', content: 'hi' },
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
  assert.equal(parent.messages.length, 0, 'forking must not mutate the parent');

  assert.throws(() => parent.forkAt(rec, 99), /No snapshot/);
  fs.rmSync(dir, { recursive: true, force: true });
});
