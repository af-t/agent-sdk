import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recording } from '../../src/core/recording.js';

function makeSse(lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

test('a tool-using run writes events and a turn snapshot to a session file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrec-'));
  const Agent = (await import('../../src/core/agent.js')).default;
  const orig = global.fetch;
  let n = 0;
  global.fetch = async () => {
    n++;
    if (n === 1) {
      return makeSse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}],"usage":null}',
        'data: [DONE]',
      ]);
    }
    return makeSse(['data: {"choices":[{"delta":{"content":"done"}}],"usage":null}', 'data: [DONE]']);
  };

  try {
    const agent = new Agent({ apiKey: 'sk-test', record: { dir } });
    agent.use({
      name: 'Echo',
      description: 'echo',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });
    await agent.run('go', () => {});
    await agent.cleanup();

    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    assert.ok(file, 'a session file should exist');
    const recs = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const types = recs.map((x) => x.type);
    assert.ok(types.includes('session_start'), 'expected session_start');
    assert.ok(types.includes('tool_calls'), 'expected tool_calls');
    assert.ok(types.includes('tool_start'), 'expected tool_start');
    assert.ok(types.includes('tool_end'), 'expected tool_end');
    assert.ok(types.includes('turn_snapshot'), 'default record level is snapshots');
    const snap = recs.find((x) => x.type === 'turn_snapshot');
    assert.ok(Array.isArray(snap.messages) && snap.messages.length > 0);
  } finally {
    global.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('non-streaming run (no notify) still records assistant and tool_calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentrec-ns-'));
  const Agent = (await import('../../src/core/agent.js')).default;
  const orig = global.fetch;
  let n = 0;
  // #send calls #request which uses res.text(), not res.json()
  global.fetch = async () => {
    n++;
    if (n === 1) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'let me echo',
                  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Echo', arguments: '{"msg":"hi"}' } }],
                },
              },
            ],
            usage: { cost: 0, total_tokens: 0 },
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { cost: 0, total_tokens: 0 },
        }),
    };
  };

  try {
    const agent = new Agent({ apiKey: 'sk-test', record: { dir } });
    agent.use({
      name: 'Echo',
      description: 'echo',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });
    // no notify callback -> non-streaming #send path
    await agent.run('go');
    await agent.cleanup();

    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    const recs = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const types = recs.map((x) => x.type);
    assert.ok(types.includes('assistant'), 'non-streaming must record assistant');
    assert.ok(types.includes('tool_calls'), 'non-streaming must record tool_calls');
    assert.ok(types.includes('tool_start'), 'expected tool_start');
    assert.ok(types.includes('tool_end'), 'expected tool_end');
    assert.ok(types.includes('turn_snapshot'), 'expected turn_snapshot');

    const trace = (await Recording.load(path.join(dir, file))).renderTrace();
    assert.match(trace, /=== turn 1 ===/);
    assert.match(trace, /\[assistant\]/);
  } finally {
    global.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
