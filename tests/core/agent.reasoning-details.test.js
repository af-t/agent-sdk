import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';

process.env.OPENROUTER_API_KEY = 'sk-test-key';

describe('Agent — reasoning_details capture', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('stores reasoning_details from a non-streaming response', async () => {
    const details = [{ type: 'reasoning.text', text: 'thinking', signature: 'sig', index: 0 }];
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'Final', reasoning: 'thinking', reasoning_details: details } },
          ],
          usage: { cost: 0.001, total_tokens: 20 },
        }),
    });

    const agent = new Agent({ apiKey: 'sk-custom' });
    await agent.run('Hello');

    const lastMsg = agent.messages[agent.messages.length - 1];
    assert.strictEqual(lastMsg.role, 'assistant');
    assert.deepStrictEqual(lastMsg.reasoning_details, details);
  });

  it('assembles reasoning_details from streaming deltas', async () => {
    global.fetch = async () => {
      const chunks = [
        'data: {"choices": [{"delta": {"reasoning_details": [{"type":"reasoning.text","text":"Think","index":0}]}}]}',
        'data: {"choices": [{"delta": {"reasoning_details": [{"type":"reasoning.text","text":"ing","signature":"sig","index":0}]}}]}',
        'data: {"choices": [{"delta": {"content": "Answer"}}]}',
        'data: [DONE]',
      ];
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk + '\n'));
          controller.close();
        },
      });
      return { ok: true, status: 200, body: readable };
    };

    const agent = new Agent({ apiKey: 'sk-custom' });
    const res = await agent.run('Hello', () => {});

    assert.strictEqual(res, 'Answer');
    const lastMsg = agent.messages[agent.messages.length - 1];
    assert.deepStrictEqual(lastMsg.reasoning_details, [
      { type: 'reasoning.text', text: 'Thinking', signature: 'sig', index: 0 },
    ]);
  });
});

describe('Agent — reasoning_details round-trip', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const details = [{ type: 'reasoning.text', text: 'thinking', signature: 'sig', index: 0 }];

  function mockTwoTurns(bodies) {
    global.fetch = async (url, options) => {
      bodies.push(JSON.parse(options.body));
      const turn = bodies.length;
      const message =
        turn === 1
          ? { role: 'assistant', content: 'First', reasoning: 'thinking', reasoning_details: details }
          : { role: 'assistant', content: 'Second' };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message }], usage: { cost: 0.001, total_tokens: 20 } }),
      };
    };
  }

  it('round-trips reasoning_details and drops the string on openrouter', async () => {
    const bodies = [];
    mockTwoTurns(bodies);

    const agent = new Agent({ apiKey: 'sk-custom' });
    await agent.run('Hello');
    await agent.run('Continue');

    const assistantMsg = bodies[1].messages.find((m) => m.role === 'assistant');
    assert.deepStrictEqual(assistantMsg.reasoning_details, details);
    assert.strictEqual(assistantMsg.reasoning, undefined);
  });

  it('retains reasoning_details on the openai dialect', async () => {
    const bodies = [];
    mockTwoTurns(bodies);

    const agent = new Agent({ apiKey: 'sk-custom', baseUrl: 'https://api.openai.com/v1' });
    await agent.run('Hello');
    await agent.run('Continue');

    const assistantMsg = bodies[1].messages.find((m) => m.role === 'assistant');
    assert.deepStrictEqual(assistantMsg.reasoning_details, details);
  });
});
