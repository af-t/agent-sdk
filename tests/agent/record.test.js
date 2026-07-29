import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Recording } from '../../src/recording/recording.js';
import { createTestTempDir } from '../support/temp.js';

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

test('a tool-using run writes events and a turn snapshot to a session file', async (t) => {
  let agent;
  t.after(() => agent?.cleanup());
  const dir = createTestTempDir(t, 'agentrec-');
  const Agent = (await import('../../src/agent/agent.js')).default;
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
    agent = new Agent({ apiKey: 'sk-test', record: { dir } });
    agent.registerTools({
      name: 'Echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
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
    assert.ok(types.includes('sessionStart'), 'expected sessionStart');
    assert.ok(types.includes('toolCalls'), 'expected toolCalls');
    assert.ok(types.includes('toolStart'), 'expected toolStart');
    assert.ok(types.includes('toolEnd'), 'expected toolEnd');
    assert.ok(types.includes('turnSnapshot'), 'default record level is snapshots');
    const snap = recs.find((x) => x.type === 'turnSnapshot');
    assert.ok(Array.isArray(snap.messages) && snap.messages.length > 0);
  } finally {
    global.fetch = orig;
  }
});

test('non-streaming run (no notify) still records assistant and toolCalls', async (t) => {
  let agent;
  t.after(() => agent?.cleanup());
  const dir = createTestTempDir(t, 'agentrec-ns-');
  const Agent = (await import('../../src/agent/agent.js')).default;
  const orig = global.fetch;
  let n = 0;
  // The non-streaming transport reads response text instead of calling response.json().
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
    agent = new Agent({ apiKey: 'sk-test', record: { dir } });
    agent.registerTools({
      name: 'Echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });
    // Without a notify callback, the run uses the non-streaming send path.
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
    assert.ok(types.includes('toolCalls'), 'non-streaming must record toolCalls');
    assert.ok(types.includes('toolStart'), 'expected toolStart');
    assert.ok(types.includes('toolEnd'), 'expected toolEnd');
    assert.ok(types.includes('turnSnapshot'), 'expected turnSnapshot');

    const trace = (await Recording.load(path.join(dir, file))).renderTrace();
    assert.match(trace, /=== turn 1 ===/);
    assert.match(trace, /\[assistant\]/);
  } finally {
    global.fetch = orig;
  }
});

test('a recorded session persists a camel-case envelope, and leaves the wire alone', async (t) => {
  let agent;
  t.after(() => agent?.cleanup());
  const dir = createTestTempDir(t, 'agentrec-camel-');
  const Agent = (await import('../../src/agent/agent.js')).default;
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
    return makeSse([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":null}',
      'data: [DONE]',
    ]);
  };

  try {
    agent = new Agent({ apiKey: 'sk-test', record: { dir, level: 'full' } });
    agent.registerTools({
      name: 'Echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });
    await agent.run('go', () => {});
    await agent.cleanup();

    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    const recording = await Recording.load(path.join(dir, file));

    // This loop checks the SDK-authored top-level recording envelope. Separate
    // protocol tests cover provider-shaped values nested inside these records.
    for (const event of recording.events) {
      assert.ok(!event.type.includes('_'), `persisted type "${event.type}" must be camel case`);
      for (const key of Object.keys(event)) {
        assert.ok(!key.includes('_'), `key "${key}" on a ${event.type} record must be camel case`);
      }
    }

    const toolEndRecord = recording.events.find((e) => e.type === 'toolEnd');
    assert.ok(toolEndRecord, 'expected a toolEnd record');
    assert.equal(typeof toolEndRecord.toolCallId, 'string');
    assert.equal(typeof toolEndRecord.durationMs, 'number');

    // The follow-up request retains the provider-required tool_call_id.
    const secondRequest = recording.requestAt(2);
    const wireTool = secondRequest.messages.find((m) => m.role === 'tool');
    assert.ok(wireTool && 'tool_call_id' in wireTool);
  } finally {
    global.fetch = orig;
  }
});
