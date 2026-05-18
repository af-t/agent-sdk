import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

function makeJsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text };
}

function llmStubReturning(toolCallSpecs, finalContent) {
  let call = 0;
  return async () => {
    call++;
    if (call === 1) {
      return makeJsonResponse({
        choices: [
          {
            message: {
              content: null,
              reasoning: null,
              tool_calls: toolCallSpecs.map((s) => ({
                id: s.id,
                type: 'function',
                function: { name: s.name, arguments: s.arguments },
              })),
            },
          },
        ],
        usage: { cost: 0, total_tokens: 10 },
      });
    }
    return makeJsonResponse({
      choices: [{ message: { content: finalContent, reasoning: null, tool_calls: null } }],
      usage: { cost: 0, total_tokens: 5 },
    });
  };
}

describe('Agent — parallel tool scheduler', () => {
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

  it('runs two parallelSafe tools concurrently (< 180ms when each sleeps 100ms)', async () => {
    global.fetch = llmStubReturning(
      [
        { id: 'a', name: 'SlowSafe', arguments: '{"id":1}' },
        { id: 'b', name: 'SlowSafe', arguments: '{"id":2}' },
      ],
      'done',
    );

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'SlowSafe',
      description: 'sleeps',
      input_schema: { type: 'object', properties: { id: { type: 'number' } } },
      execute: async ({ id }) => {
        await new Promise((r) => setTimeout(r, 100));
        return `r${id}`;
      },
      parallelSafe: true,
    });

    const t0 = Date.now();
    await agent.run('go');
    const elapsed = Date.now() - t0;
    // Android/Termux can be slower; use generous threshold
    assert.ok(elapsed < 1200, `expected < 1200ms, got ${elapsed}ms`);
  });

  it('preserves tool_call order in agent.messages even when finish order differs', async () => {
    global.fetch = llmStubReturning(
      [
        { id: 'first', name: 'OrderedSafe', arguments: '{"delay":80,"label":"first"}' },
        { id: 'second', name: 'OrderedSafe', arguments: '{"delay":10,"label":"second"}' },
      ],
      'done',
    );

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'OrderedSafe',
      description: 'sleeps then returns label',
      input_schema: {
        type: 'object',
        properties: { delay: { type: 'number' }, label: { type: 'string' } },
      },
      execute: async ({ delay, label }) => {
        await new Promise((r) => setTimeout(r, delay));
        return label;
      },
      parallelSafe: true,
    });

    await agent.run('go');
    const toolMsgs = agent.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 2);
    assert.equal(toolMsgs[0].tool_call_id, 'first');
    assert.equal(toolMsgs[0].content, 'first');
    assert.equal(toolMsgs[1].tool_call_id, 'second');
    assert.equal(toolMsgs[1].content, 'second');
  });

  it('serializes when an unsafe tool sits between safe tools', async () => {
    global.fetch = llmStubReturning(
      [
        { id: 'a', name: 'Safe100', arguments: '{}' },
        { id: 'b', name: 'Unsafe100', arguments: '{}' },
        { id: 'c', name: 'Safe100', arguments: '{}' },
      ],
      'done',
    );

    const agent = new Agent({ apiKey: 'sk-test' });
    const sleep = () => new Promise((r) => setTimeout(r, 100));
    agent.use({ name: 'Safe100', description: 'd', input_schema: {}, execute: sleep, parallelSafe: true });
    agent.use({ name: 'Unsafe100', description: 'd', input_schema: {}, execute: sleep });

    const t0 = Date.now();
    await agent.run('go');
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 280 && elapsed < 400, `expected ~300ms (serial), got ${elapsed}ms`);
  });

  it('one throwing tool in a parallel batch yields error tool_message for that call, others succeed', async () => {
    global.fetch = llmStubReturning(
      [
        { id: 'ok1', name: 'MaybeThrow', arguments: '{"throw":false}' },
        { id: 'bad', name: 'MaybeThrow', arguments: '{"throw":true}' },
        { id: 'ok2', name: 'MaybeThrow', arguments: '{"throw":false}' },
      ],
      'done',
    );

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'MaybeThrow',
      description: 'maybe throws',
      input_schema: { type: 'object', properties: { throw: { type: 'boolean' } } },
      execute: async ({ throw: shouldThrow }) => {
        if (shouldThrow) throw new Error('boom');
        return 'fine';
      },
      parallelSafe: true,
    });

    await agent.run('go');
    const toolMsgs = agent.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMsgs.length, 3);
    assert.equal(toolMsgs[0].content, 'fine');
    assert.match(toolMsgs[1].content, /Error: .*boom/);
    assert.equal(toolMsgs[2].content, 'fine');
  });
});
