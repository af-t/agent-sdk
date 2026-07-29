import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const mockRes = (status, bodyObj) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(bodyObj),
  json: async () => bodyObj,
});

// This fixture represents a tool message with an image attachment.
const multimodalToolMsg = {
  role: 'tool',
  tool_call_id: 'c1',
  content: [
    { type: 'text', text: '[image] x.png' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
  ],
};

describe('Agent: multimodal degradation', () => {
  let Agent;
  let realFetch;

  before(async () => {
    const mod = await import('../../src/agent/agent.js');
    Agent = mod.default;
    realFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it('retries with degraded payload after 400 and resolves to final content', async () => {
    const agent = new Agent({ apiKey: 'sk-test' });

    // Conversation history begins with a multimodal tool result.
    agent.messages = [
      { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }],
      },
      { ...multimodalToolMsg },
    ];

    const bodies = [];
    let callCount = 0;

    globalThis.fetch = async (_url, opts) => {
      callCount++;
      bodies.push(JSON.parse(opts.body));
      if (callCount === 1) {
        return mockRes(400, { error: { message: 'unsupported content' } });
      }
      return mockRes(200, {
        choices: [{ message: { content: 'done', tool_calls: null } }],
        usage: {},
      });
    };

    const result = await agent.run('continue');

    assert.strictEqual(callCount, 2, 'expected exactly two fetch calls');

    // The original request includes the image attachment.
    const firstToolMsg = bodies[0].messages.find((m) => m.role === 'tool');
    assert.ok(Array.isArray(firstToolMsg.content), 'first request: tool content should be array');
    assert.ok(
      firstToolMsg.content.some((p) => p.type === 'image_url'),
      'first request: should still have image_url part',
    );

    // The retry replaces the image attachment with text.
    const secondToolMsg = bodies[1].messages.find((m) => m.role === 'tool');
    assert.strictEqual(typeof secondToolMsg.content, 'string', 'second request: tool content should be a string');
    assert.ok(!secondToolMsg.content.includes('image_url'), 'second request: should not contain image_url');

    assert.strictEqual(result, 'done');
  });

  it('subsequent run() sends already-degraded payload on first fetch', async () => {
    // This fresh agent first passes through the degradation path.
    const agent = new Agent({ apiKey: 'sk-test' });

    agent.messages = [
      { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'readFile', arguments: '{}' } }],
      },
      { ...multimodalToolMsg },
    ];

    let phase = 'degrade';
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (phase === 'degrade') {
        const tc = body.messages.find((m) => m.role === 'tool');
        if (tc && Array.isArray(tc.content) && tc.content.some((p) => p.type === 'image_url')) {
          // Rejecting rich content marks this run as text-only.
          return mockRes(400, { error: { message: 'unsupported content' } });
        }
        // The degraded request succeeds.
        phase = 'done';
        return mockRes(200, {
          choices: [{ message: { content: 'first run done', tool_calls: null } }],
          usage: {},
        });
      }
      // The first run ends before this branch.
      return mockRes(200, {
        choices: [{ message: { content: 'unexpected', tool_calls: null } }],
        usage: {},
      });
    };

    await agent.run('continue');

    // The second run captures the request and succeeds immediately.
    const secondRunBodies = [];
    globalThis.fetch = async (_url, opts) => {
      secondRunBodies.push(JSON.parse(opts.body));
      return mockRes(200, {
        choices: [{ message: { content: 'second run done', tool_calls: null } }],
        usage: {},
      });
    };

    await agent.run('next prompt');

    assert.strictEqual(secondRunBodies.length, 1, 'expected exactly one fetch on second run');
    const toolMsg = secondRunBodies[0].messages.find((m) => m.role === 'tool');
    // The degraded tool message is text and contains no image URL.
    assert.strictEqual(typeof toolMsg.content, 'string', 'second run: tool content should be pre-degraded string');
    assert.ok(!toolMsg.content.includes('image_url'), 'second run: no image_url in degraded content');
  });
});
