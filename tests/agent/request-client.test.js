import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RequestClient } from '../../src/agent/request-client.js';
import { ApiError } from '../../src/support/errors.js';
import { resolveLogger } from '../../src/support/logger.js';

function createRecordingLogger() {
  const records = [];
  const target = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    target[level] = (context, message) => records.push({ level, context, message });
  }
  return { logger: resolveLogger(target), records };
}

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function sseResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
        controller.close();
      },
    }),
  };
}

function createClient({ transport, baseUrl = 'https://openrouter.ai/api/v1', retryOptions } = {}) {
  const { logger, records } = createRecordingLogger();
  const client = new RequestClient({
    apiKey: 'test-key',
    baseUrl,
    model: 'test/model',
    logger,
    transport,
    retryOptions: retryOptions ?? { attempts: 1 },
  });
  return { client, records };
}

const userPayload = { messages: [{ role: 'user', content: 'hello' }] };

const richPayload = () => ({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ],
});

describe('RequestClient', () => {
  it('posts the payload to the chat-completions endpoint with OpenRouter headers', async () => {
    const requests = [];
    const { client } = createClient({
      transport: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
      },
    });

    const response = await client.request(userPayload, { signal: new AbortController().signal, stream: false });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(requests[0].options.headers, {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/af-t/agent-sdk',
      'X-Title': 'OpenRouter CLI Agent',
      'X-OpenRouter-Title': 'OpenRouter CLI Agent',
    });
    assert.deepEqual(JSON.parse(requests[0].options.body), { ...userPayload, stream: false });
    assert.equal(response.message.content, 'done');
  });

  it('omits the OpenRouter-only headers on the OpenAI dialect', async () => {
    const requests = [];
    const { client } = createClient({
      baseUrl: 'https://api.openai.com/v1',
      transport: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({ choices: [{ message: { content: 'done' } }] });
      },
    });

    await client.request(userPayload, {});

    assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.deepEqual(requests[0].options.headers, {
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    });
  });

  it('normalizes a non-streaming response for the run loop', async () => {
    const raw = {
      id: 'gen-1',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning: 'thought',
            reasoning_details: [{ type: 'reasoning.text', text: 'thought' }],
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        cost: 0.25,
        total_tokens: 42,
        prompt_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
      },
    };
    const { client } = createClient({ transport: async () => jsonResponse(raw) });

    const response = await client.request(userPayload, {});

    assert.equal(response.message.content, 'answer');
    assert.equal(response.message.tool_calls[0].id, 'c1');
    assert.equal(response.finishReason, 'tool_calls');
    assert.equal(response.reasoning, 'thought');
    assert.deepEqual(response.reasoningDetails, [{ type: 'reasoning.text', text: 'thought' }]);
    assert.deepEqual(response.usage, { cost: 0.25, tokens: 42, cachedTokens: 7, cacheWriteTokens: 3 });
    assert.deepEqual(response.raw, raw, 'the provider response stays available for recording');
  });

  it('reports a response without choices as an empty message instead of throwing', async () => {
    const { client } = createClient({ transport: async () => jsonResponse({ choices: [] }) });

    const response = await client.request(userPayload, {});

    assert.equal(response.message, undefined);
    assert.equal(response.finishReason, undefined);
    assert.deepEqual(response.usage, { cost: 0, tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
  });

  it('rejects a body that is not JSON', async () => {
    const { client } = createClient({
      transport: async () => ({ ok: true, status: 200, text: async () => '<html>gateway</html>' }),
    });

    await assert.rejects(() => client.request(userPayload, {}), /Failed to parse OpenRouter response as JSON/);
  });

  it('raises an ApiError carrying the provider status and body', async () => {
    const { client } = createClient({
      transport: async () => jsonResponse({ error: { message: 'no credits' } }, { status: 402 }),
    });

    await assert.rejects(
      () => client.request(userPayload, {}),
      (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 402);
        assert.equal(error.message, 'no credits');
        assert.deepEqual(error.body, { error: { message: 'no credits' } });
        return true;
      },
    );
  });

  it('does not retry a 400 but does retry a 429', async () => {
    let badRequestCalls = 0;
    const { client: strict } = createClient({
      retryOptions: { attempts: 3, baseDelayMs: 1 },
      transport: async () => {
        badRequestCalls += 1;
        return jsonResponse({ error: { message: 'bad request' } }, { status: 400 });
      },
    });

    await assert.rejects(() => strict.request(userPayload, {}), /bad request/);
    assert.equal(badRequestCalls, 1, 'a 400 is not retryable');

    let rateLimitedCalls = 0;
    const { client: throttled } = createClient({
      retryOptions: { attempts: 3, baseDelayMs: 1 },
      transport: async () => {
        rateLimitedCalls += 1;
        if (rateLimitedCalls === 1) return jsonResponse({ error: { message: 'rate limited' } }, { status: 429 });
        return jsonResponse({ choices: [{ message: { content: 'done' } }] });
      },
    });

    const response = await throttled.request(userPayload, {});
    assert.equal(rateLimitedCalls, 2, 'a 429 is retried');
    assert.equal(response.message.content, 'done');
  });

  it('assembles content, tool calls, and usage from SSE chunks', async () => {
    const requests = [];
    const chunks = [];
    const { client } = createClient({
      transport: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return sseResponse([
          'data: {"choices":[{"delta":{"reasoning":"think"}}]}',
          'data: {"choices":[{"delta":{"content":"he"}}]}',
          'data: {"choices":[{"delta":{"content":"llo","tool_calls":[{"index":0,"id":"c1","function":{"name":"pro","arguments":"{\\"a\\":"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"be","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}',
          'data: {"choices":[],"usage":{"total_tokens":15,"cost":0.5}}',
          'data: [DONE]',
        ]);
      },
    });

    const response = await client.request(userPayload, { stream: true, onChunk: (chunk) => chunks.push(chunk) });

    assert.equal(requests[0].stream, true);
    assert.deepEqual(requests[0].stream_options, { include_usage: true });
    assert.equal(response.message.content, 'hello');
    assert.equal(response.reasoning, 'think');
    assert.equal(response.finishReason, 'tool_calls');
    assert.deepEqual(response.message.tool_calls, [
      { id: 'c1', type: 'function', function: { name: 'probe', arguments: '{"a":1}' } },
    ]);
    assert.deepEqual(response.usage, { cost: 0.5, tokens: 15, cachedTokens: 0, cacheWriteTokens: 0 });
    assert.deepEqual(
      chunks.map((chunk) => [chunk.contentDelta, chunk.reasoningDelta, chunk.content]),
      [
        ['', 'think', ''],
        ['he', '', 'he'],
        ['llo', '', 'hello'],
      ],
      'each delta carries the fragment and the text accumulated so far',
    );
  });

  it('adds up usage reported across several SSE chunks', async () => {
    const { client } = createClient({
      transport: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"a"}}],"usage":{"total_tokens":4,"cost":0.25,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":1}}}',
          'data: {"choices":[{"delta":{"content":"b"}}],"usage":{"total_tokens":6,"cost":0.5,"prompt_tokens_details":{"cached_tokens":3}}}',
          'data: [DONE]',
        ]),
    });

    const response = await client.request(userPayload, { stream: true });

    assert.deepEqual(response.usage, { cost: 0.75, tokens: 10, cachedTokens: 5, cacheWriteTokens: 1 });
  });

  it('skips malformed SSE lines instead of failing the request', async () => {
    const { client } = createClient({
      transport: async () =>
        sseResponse([
          ': keep-alive comment',
          'data: {"choices":[{"delta":{"content":"ok"}}]',
          'data: {"choices":[{"delta":{"content":"fine"}}]}',
          'data: [DONE]',
        ]),
    });

    const response = await client.request(userPayload, { stream: true });

    assert.equal(response.message.content, 'fine');
  });

  it('turns a caller abort into an abort error that keeps the in-flight failure as its cause', async () => {
    const controller = new AbortController();
    let calls = 0;
    const { client } = createClient({
      retryOptions: { attempts: 3, baseDelayMs: 1 },
      transport: async () => {
        calls += 1;
        controller.abort();
        return jsonResponse({ error: { message: 'Insufficient balance' } }, { status: 402 });
      },
    });

    await assert.rejects(
      () => client.request(userPayload, { signal: controller.signal }),
      (error) => {
        assert.match(error.message, /Agent run aborted/);
        assert.equal(error.aborted, true);
        assert.equal(error.cause.status, 402);
        assert.match(error.cause.message, /Insufficient balance/);
        return true;
      },
    );
    assert.equal(calls, 1, 'an observed caller abort must not be retried');
  });

  it('never reaches the transport when the caller signal is already aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const { client } = createClient({
      transport: async () => {
        calls += 1;
        return jsonResponse({ choices: [{ message: { content: 'done' } }] });
      },
    });

    await assert.rejects(
      () => client.request(userPayload, { signal: controller.signal }),
      (error) => error.aborted === true,
    );
    assert.equal(calls, 0);
  });

  it('degrades the payload and retries once when the provider rejects its non-text parts', async () => {
    const bodies = [];
    const degraded = [];
    const { client, records } = createClient({
      retryOptions: { attempts: 1 },
      transport: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) return jsonResponse({ error: { message: 'unsupported file' } }, { status: 400 });
        return jsonResponse({ choices: [{ message: { content: 'done' } }] });
      },
    });

    const payload = richPayload();
    const response = await client.request(payload, { onDegrade: (current) => degraded.push(current) });

    assert.equal(bodies.length, 2);
    assert.ok(
      bodies[0].messages[0].content.some((part) => part.type === 'image_url'),
      'the first attempt still carries the image part',
    );
    assert.equal(bodies[1].messages[0].content, 'look at this', 'the retry carries text only');
    assert.deepEqual(degraded, [payload], 'the caller is handed the degraded payload before the retry');
    assert.equal(response.message.content, 'done');
    assert.ok(
      records.some((record) => record.level === 'warn' && /degrading/i.test(record.message)),
      'the fallback is reported once as a warning',
    );
  });

  it('leaves a text-only payload alone when the provider rejects it', async () => {
    let calls = 0;
    const { client } = createClient({
      transport: async () => {
        calls += 1;
        return jsonResponse({ error: { message: 'bad request' } }, { status: 400 });
      },
    });

    await assert.rejects(() => client.request(userPayload, {}), /bad request/);
    assert.equal(calls, 1, 'there is nothing to degrade, so there is nothing to retry');
  });

  it('logs one structured entry per request attempt', async () => {
    let calls = 0;
    const { client, records } = createClient({
      retryOptions: { attempts: 3, baseDelayMs: 1 },
      transport: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse({ error: { message: 'rate limited' } }, { status: 429 });
        return jsonResponse({ choices: [{ message: { content: 'done' } }] });
      },
    });

    await client.request(userPayload, { stream: false });

    const sent = records.filter((record) => record.message === 'Sending model request');
    assert.deepEqual(
      sent.map((record) => record.context),
      [
        { component: 'requestClient', model: 'test/model', stream: false, attempt: 1 },
        { component: 'requestClient', model: 'test/model', stream: false, attempt: 2 },
      ],
    );
  });

  it('is driven only by the injected transport, with no module-level override', async () => {
    const module = await import('../../src/agent/request-client.js');
    const { client } = createClient({ transport: async () => jsonResponse({ choices: [] }) });

    assert.equal(module._setTransport, undefined, 'transport is injected per client, not swapped globally');
    assert.equal(client._setTransport, undefined);
  });
});
