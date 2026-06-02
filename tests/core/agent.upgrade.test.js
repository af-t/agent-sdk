import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';

process.env.OPENROUTER_API_KEY = 'sk-test-key';

describe('Agent Upgrade — modern parameters and reasoning', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('constructor correctly parses and sets new parameters', () => {
    const agent = new Agent({
      apiKey: 'sk-custom',
      temperature: 0.7,
      topP: 0.9,
      minP: 0.1,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.6,
      repetitionPenalty: 1.2,
      seed: 42,
      maxCompletionTokens: 150,
      responseFormat: { type: 'json_object' },
      stop: ['\n'],
      reasoning: {
        effort: 'high',
        maxTokens: 1000,
        exclude: true,
        enabled: true,
      },
      provider: {
        order: ['openai', 'anthropic'],
        only: ['openai'],
        avoid: ['together'],
        sort: 'throughput',
        allowFallbacks: false,
        requireParameters: true,
        dataCollection: 'deny',
      },
    });

    assert.strictEqual(agent.temperature, 0.7);
    assert.strictEqual(agent.topP, 0.9);
    assert.strictEqual(agent.minP, 0.1);
    assert.strictEqual(agent.topK, 40);
    assert.strictEqual(agent.frequencyPenalty, 0.5);
    assert.strictEqual(agent.presencePenalty, 0.6);
    assert.strictEqual(agent.repetitionPenalty, 1.2);
    assert.strictEqual(agent.seed, 42);
    assert.strictEqual(agent.maxCompletionTokens, 150);
    assert.deepEqual(agent.responseFormat, { type: 'json_object' });
    assert.deepEqual(agent.stop, ['\n']);

    assert.deepEqual(agent.reasoning, {
      effort: 'high',
      maxTokens: 1000,
      exclude: true,
      enabled: true,
    });

    assert.deepEqual(agent.provider, {
      order: ['openai', 'anthropic'],
      only: ['openai'],
      avoid: ['together'],
      sort: 'throughput',
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
    });
  });

  it('builds request payload with new parameters correctly', async () => {
    let capturedPayload = null;

    global.fetch = async (url, opts) => {
      capturedPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Test response' } }],
            usage: { cost: 0.001, total_tokens: 10 },
          }),
      };
    };

    const agent = new Agent({
      apiKey: 'sk-custom',
      temperature: 0.7,
      topP: 0.9,
      minP: 0.1,
      topK: 40,
      frequencyPenalty: 0.5,
      presencePenalty: 0.6,
      repetitionPenalty: 1.2,
      seed: 42,
      maxCompletionTokens: 150,
      responseFormat: { type: 'json_object' },
      stop: ['\n'],
      reasoning: {
        effort: 'high',
        maxTokens: 1000,
        exclude: true,
        enabled: true,
      },
      provider: {
        order: ['openai', 'anthropic'],
        only: ['openai'],
        avoid: ['together'],
        sort: 'throughput',
        allowFallbacks: false,
        requireParameters: true,
        dataCollection: 'deny',
      },
    });

    await agent.run('Hello');

    assert.ok(capturedPayload);
    assert.strictEqual(capturedPayload.temperature, 0.7);
    assert.strictEqual(capturedPayload.top_p, 0.9);
    assert.strictEqual(capturedPayload.min_p, 0.1);
    assert.strictEqual(capturedPayload.top_k, 40);
    assert.strictEqual(capturedPayload.frequency_penalty, 0.5);
    assert.strictEqual(capturedPayload.presence_penalty, 0.6);
    assert.strictEqual(capturedPayload.repetition_penalty, 1.2);
    assert.strictEqual(capturedPayload.seed, 42);
    assert.strictEqual(capturedPayload.max_completion_tokens, 150);
    assert.deepEqual(capturedPayload.response_format, { type: 'json_object' });
    assert.deepEqual(capturedPayload.stop, ['\n']);

    assert.deepEqual(capturedPayload.reasoning, {
      effort: 'high',
      max_tokens: 1000,
      exclude: true,
      enabled: true,
    });

    assert.deepEqual(capturedPayload.provider, {
      order: ['openai', 'anthropic'],
      only: ['openai'],
      avoid: ['together'],
      sort: 'throughput',
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      dataCollection: 'deny',
    });
  });

  it('ignores the removed maxTokens option and never emits max_tokens in the payload', async () => {
    let capturedPayload = null;

    global.fetch = async (url, opts) => {
      capturedPayload = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'ok' } }],
            usage: { cost: 0, total_tokens: 1 },
          }),
      };
    };

    const agent = new Agent({ apiKey: 'sk-custom', maxTokens: 999 });
    assert.strictEqual(agent.maxTokens, undefined);

    await agent.run('Hello');

    assert.strictEqual(capturedPayload.max_tokens, undefined);
  });

  it('extracts the modern reasoning field from a non-streaming response', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Final content', reasoning: 'Thought process here' } }],
          usage: { cost: 0.001, total_tokens: 20 },
        }),
    });

    const agent = new Agent({ apiKey: 'sk-custom' });
    const res = await agent.run('Hello');

    assert.strictEqual(res, 'Final content');
    const lastMsg = agent.messages[agent.messages.length - 1];
    assert.strictEqual(lastMsg.role, 'assistant');
    assert.strictEqual(lastMsg.reasoning, 'Thought process here');
    assert.strictEqual(lastMsg.content, 'Final content');
  });

  it('ignores the legacy reasoning_content field in a non-streaming response', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Final content', reasoning_content: 'Old reasoning' } }],
          usage: { cost: 0.001, total_tokens: 20 },
        }),
    });

    const agent = new Agent({ apiKey: 'sk-custom' });
    await agent.run('Hello');

    const lastMsg = agent.messages[agent.messages.length - 1];
    assert.strictEqual(lastMsg.reasoning, undefined);
  });

  it('extracts the modern reasoning field from a streaming response', async () => {
    global.fetch = async () => {
      const chunks = [
        'data: {"choices": [{"delta": {"reasoning": "Thinking..."}}]}',
        'data: {"choices": [{"delta": {"content": "Hello "}}]}',
        'data: {"choices": [{"delta": {"reasoning": " more thinking"}}]}',
        'data: {"choices": [{"delta": {"content": "world!"}}]}',
        'data: [DONE]',
      ];

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + '\n'));
          }
          controller.close();
        },
      });

      return { ok: true, status: 200, body: readable };
    };

    const agent = new Agent({ apiKey: 'sk-custom' });
    const res = await agent.run('Hello', () => {});

    assert.strictEqual(res, 'Hello world!');
    const lastMsg = agent.messages[agent.messages.length - 1];
    assert.strictEqual(lastMsg.role, 'assistant');
    assert.strictEqual(lastMsg.reasoning, 'Thinking... more thinking');
    assert.strictEqual(lastMsg.content, 'Hello world!');
  });

  it('ignores the legacy reasoning_content field in a streaming response', async () => {
    global.fetch = async () => {
      const chunks = [
        'data: {"choices": [{"delta": {"reasoning_content": "Thinking..."}}]}',
        'data: {"choices": [{"delta": {"content": "Hello world!"}}]}',
        'data: [DONE]',
      ];

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk + '\n'));
          }
          controller.close();
        },
      });

      return { ok: true, status: 200, body: readable };
    };

    const agent = new Agent({ apiKey: 'sk-custom' });
    const res = await agent.run('Hello', () => {});

    assert.strictEqual(res, 'Hello world!');
    const lastMsg = agent.messages[agent.messages.length - 1];
    assert.strictEqual(lastMsg.reasoning, undefined);
  });
});
