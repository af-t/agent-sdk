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

describe('Agent: toolStart / toolEnd notify events', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/agent/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('emits toolStart and toolEnd for a successful tool call', async () => {
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
    agent.registerTools({
      name: 'Echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });

    const updates = [];
    await agent.run('go', (u) => updates.push(u));

    const start = updates.find((u) => u.toolStart);
    const end = updates.find((u) => u.toolEnd);
    assert.ok(start, 'expected toolStart');
    assert.equal(start.toolStart.toolCallId, 'c1');
    assert.equal(start.toolStart.name, 'Echo');
    assert.deepEqual(start.toolStart.input, { msg: 'hi' });

    assert.ok(end, 'expected toolEnd');
    assert.equal(end.toolEnd.toolCallId, 'c1');
    assert.equal(end.toolEnd.name, 'Echo');
    assert.equal(end.toolEnd.output, 'hi');
    assert.equal(end.toolEnd.error, undefined);
    assert.ok(end.toolEnd.durationMs >= 0);
  });

  it('emits toolEnd with error field when tool throws', async () => {
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
    agent.registerTools({
      name: 'Boom',
      description: 'd',
      inputSchema: {},
      execute: async () => {
        throw new Error('kaboom');
      },
    });

    const updates = [];
    await agent.run('go', (u) => updates.push(u));
    const end = updates.find((u) => u.toolEnd);
    assert.ok(end);
    assert.equal(end.toolEnd.error, 'kaboom');
    assert.equal(end.toolEnd.output, undefined);
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
    agent.registerTools({
      name: 'Ok',
      description: 'd',
      inputSchema: {},
      execute: async () => 'ok',
    });

    const result = await agent.run('go', () => {
      throw new Error('notify failed');
    });
    assert.equal(result, 'done');
  });

  it('delivers a fully camel-case envelope, and leaves the wire fields alone', async () => {
    let n = 0;
    global.fetch = async () => {
      n++;
      if (n === 1) {
        return makeSseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"Echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]},"finish_reason":"tool_calls"}],"usage":null}',
          'data: [DONE]',
        ]);
      }
      return makeSseResponse([
        'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":null}',
        'data: [DONE]',
      ]);
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.registerTools({
      name: 'Echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });

    // subscribe(), not the run() notify param: turnEnd is routed only to
    // subscribed callbacks (see Agent#broadcast), so a plain notify callback
    // would never see it.
    const events = [];
    agent.subscribe((event) => events.push(event));
    await agent.run('go');

    const keys = new Set(events.flatMap((event) => Object.keys(event)));
    assert.deepEqual(
      [...keys].filter((key) => key.includes('_')),
      [],
    );

    const toolEnd = events.find((event) => event.toolEnd).toolEnd;
    assert.deepEqual(Object.keys(toolEnd).sort(), ['durationMs', 'name', 'output', 'toolCallId']);

    const turnEnd = events.find((event) => event.turnEnd).turnEnd;
    assert.equal(typeof turnEnd.finishReason, 'string');

    // The rename stops at the envelope: the outbound payload still carries
    // the provider-required tool_call_id and reasoning_details fields.
    const payload = await agent._buildPayload();
    const wireTool = payload.messages.find((m) => m.role === 'tool');
    assert.ok(wireTool && 'tool_call_id' in wireTool);
    const wireAssistant = payload.messages.find((m) => m.role === 'assistant');
    assert.ok(wireAssistant && 'reasoning_details' in wireAssistant);
  });
});
