import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

function makeJsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

describe('Agent — abort propagation', () => {
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

  it('ctx.signal is defined inside a tool even when run() called without signal option', async () => {
    let observed;
    let count = 0;
    global.fetch = async () => {
      count++;
      if (count === 1) {
        return makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                reasoning: null,
                tool_calls: [{ id: 'a', type: 'function', function: { name: 'SeesSignal', arguments: '{}' } }],
              },
            },
          ],
          usage: { cost: 0, total_tokens: 5 },
        });
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'done', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 5 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'SeesSignal',
      description: 'd',
      input_schema: {},
      execute: async (_input, ctx) => {
        observed = ctx.signal;
        return 'ok';
      },
    });
    await agent.run('go');
    assert.ok(observed instanceof AbortSignal);
    assert.equal(observed.aborted, false);
  });

  it('signal-aware tool throws quickly on abort; run() rejects', async () => {
    let llmCalls = 0;
    const ctrl = new AbortController();
    global.fetch = async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                reasoning: null,
                tool_calls: [{ id: 'a', type: 'function', function: { name: 'WaitForAbort', arguments: '{}' } }],
              },
            },
          ],
          usage: { cost: 0, total_tokens: 5 },
        });
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'never', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 1 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'WaitForAbort',
      description: 'd',
      input_schema: {},
      execute: async (_input, ctx) =>
        new Promise((_, rej) => {
          ctx.signal.addEventListener('abort', () => rej(new Error('aborted by signal')));
        }),
    });

    setTimeout(() => ctrl.abort(), 30);
    await assert.rejects(() => agent.run('go', null, { signal: ctrl.signal }), /Agent run aborted/);
  });

  it('signal-unaware tool still completes its batch; run() rejects after', async () => {
    let llmCalls = 0;
    const ctrl = new AbortController();
    global.fetch = async () => {
      llmCalls++;
      if (llmCalls === 1) {
        return makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                reasoning: null,
                tool_calls: [{ id: 'a', type: 'function', function: { name: 'IgnoresSignal', arguments: '{}' } }],
              },
            },
          ],
          usage: { cost: 0, total_tokens: 5 },
        });
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'never', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 1 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'IgnoresSignal',
      description: 'd',
      input_schema: {},
      execute: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return 'completed';
      },
    });

    setTimeout(() => ctrl.abort(), 30);
    const t0 = Date.now();
    await assert.rejects(() => agent.run('go', null, { signal: ctrl.signal }), /Agent run aborted/);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 90, `expected at least 90ms (tool must finish), got ${elapsed}ms`);
  });
});
