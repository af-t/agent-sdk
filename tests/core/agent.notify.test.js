import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

function makeSseResponse(lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

describe('Agent — tool_start / tool_end notify events', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('emits tool_start and tool_end for a successful tool call', async () => {
    let n = 0;
    global.fetch = async () => {
      n++;
      if (n === 1) {
        return makeSseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}],"usage":null}',
          'data: [DONE]',
        ]);
      }
      return makeSseResponse(['data: {"choices":[{"delta":{"content":"done"}}],"usage":null}', 'data: [DONE]']);
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'Echo',
      description: 'echo',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });

    const updates = [];
    await agent.run('go', (u) => updates.push(u));

    const start = updates.find((u) => u.tool_start);
    const end = updates.find((u) => u.tool_end);
    assert.ok(start, 'expected tool_start');
    assert.equal(start.tool_start.tool_call_id, 'c1');
    assert.equal(start.tool_start.name, 'Echo');
    assert.deepEqual(start.tool_start.input, { msg: 'hi' });

    assert.ok(end, 'expected tool_end');
    assert.equal(end.tool_end.tool_call_id, 'c1');
    assert.equal(end.tool_end.name, 'Echo');
    assert.equal(end.tool_end.output, 'hi');
    assert.equal(end.tool_end.error, undefined);
    assert.ok(end.tool_end.duration_ms >= 0);
  });

  it('emits tool_end with error field when tool throws', async () => {
    let n = 0;
    global.fetch = async () => {
      n++;
      if (n === 1) {
        return makeSseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Boom","arguments":"{}"}}]}}],"usage":null}',
          'data: [DONE]',
        ]);
      }
      return makeSseResponse(['data: {"choices":[{"delta":{"content":"done"}}],"usage":null}', 'data: [DONE]']);
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'Boom',
      description: 'd',
      input_schema: {},
      execute: async () => {
        throw new Error('kaboom');
      },
    });

    const updates = [];
    await agent.run('go', (u) => updates.push(u));
    const end = updates.find((u) => u.tool_end);
    assert.ok(end);
    assert.equal(end.tool_end.error, 'kaboom');
    assert.equal(end.tool_end.output, undefined);
  });

  it('notify that throws does not crash the run', async () => {
    let n = 0;
    global.fetch = async () => {
      n++;
      if (n === 1) {
        return makeSseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Ok","arguments":"{}"}}]}}],"usage":null}',
          'data: [DONE]',
        ]);
      }
      return makeSseResponse(['data: {"choices":[{"delta":{"content":"done"}}],"usage":null}', 'data: [DONE]']);
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'Ok',
      description: 'd',
      input_schema: {},
      execute: async () => 'ok',
    });

    const result = await agent.run('go', () => {
      throw new Error('notify failed');
    });
    assert.equal(result, 'done');
  });
});
