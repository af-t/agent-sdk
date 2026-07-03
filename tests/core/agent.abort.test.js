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
          const fail = () => rej(new Error('aborted by signal'));
          // abort is one-shot: if the signal already fired before the tool ran,
          // addEventListener('abort') would never call back and the promise would
          // never settle, wedging the run loop. Handle the pre-aborted case first.
          if (ctx.signal.aborted) return fail();
          ctx.signal.addEventListener('abort', fail, { once: true });
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

  it('aborts the in-flight LLM fetch; run() rejects without waiting for the response', async () => {
    const ctrl = new AbortController();
    global.fetch = (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              makeJsonResponse({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0, total_tokens: 1 } }),
            ),
          300,
        );
        if (init.signal?.aborted) {
          clearTimeout(timer);
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          return;
        }
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
      });

    const agent = new Agent({ apiKey: 'sk-test' });
    setTimeout(() => ctrl.abort(), 30);
    const t0 = Date.now();
    await assert.rejects(() => agent.run('go', null, { signal: ctrl.signal }), /Agent run aborted/);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 250, `run should reject before the 300ms response, got ${elapsed}ms`);
  });

  it('rejects instead of resolving when abort lands before a terminal response is committed', async () => {
    // fetch deliberately ignores init.signal — exercises the post-response check
    const ctrl = new AbortController();
    global.fetch = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return makeJsonResponse({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0, total_tokens: 1 } });
    };
    const agent = new Agent({ apiKey: 'sk-test' });
    setTimeout(() => ctrl.abort(), 30);
    await assert.rejects(() => agent.run('go', null, { signal: ctrl.signal }), /Agent run aborted/);
  });

  it('streaming: mid-stream abort rejects with Agent run aborted', async () => {
    const ctrl = new AbortController();
    global.fetch = async (_url, init) => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(streamCtrl) {
          streamCtrl.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"he"}}]}\n\n'));
          const fail = () =>
            streamCtrl.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          if (init.signal?.aborted) return fail();
          init.signal?.addEventListener('abort', fail);
          // stream never closes on its own; only the abort tears it down
        },
      }),
    });
    const agent = new Agent({ apiKey: 'sk-test' });
    setTimeout(() => ctrl.abort(), 30);
    // a notify callback forces the streaming (#sendStream) path
    await assert.rejects(() => agent.run('go', () => {}, { signal: ctrl.signal }), /Agent run aborted/);
  });

  it('streaming: a retryable non-ok response observed after caller abort rejects fast instead of retrying', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    global.fetch = async () => {
      calls++;
      // Simulate the response landing right as the caller cancels.
      ctrl.abort();
      return { ok: false, status: 429, json: async () => ({ error: { message: 'rate limited' } }) };
    };
    const agent = new Agent({ apiKey: 'sk-test' });
    const t0 = Date.now();
    // a notify callback forces the streaming (#sendStream) path
    await assert.rejects(() => agent.run('go', () => {}, { signal: ctrl.signal }), /Agent run aborted/);
    assert.equal(calls, 1, 'must not retry once the caller signal is observed as aborted');
    assert.ok(
      Date.now() - t0 < 500,
      `expected a fast rejection, not a multi-second retry backoff, got ${Date.now() - t0}ms`,
    );
  });

  it('preserves the original error as err.cause when the caller aborted mid-request', async () => {
    const ctrl = new AbortController();
    global.fetch = async () => {
      ctrl.abort();
      return {
        ok: false,
        status: 402,
        text: async () => JSON.stringify({ error: { message: 'Insufficient balance' } }),
      };
    };
    const agent = new Agent({ apiKey: 'sk-test' });
    try {
      await agent.run('go', null, { signal: ctrl.signal });
      assert.fail('expected run() to reject');
    } catch (err) {
      assert.match(err.message, /Agent run aborted/);
      assert.equal(err.aborted, true);
      assert.equal(err.cause?.status, 402, 'expected the original ApiError preserved as err.cause');
      assert.match(err.cause?.message, /Insufficient balance/);
    }
  });

  it('the post-response abort check uses callerAbortError so .aborted is set', async () => {
    const ctrl = new AbortController();
    global.fetch = async () => {
      await new Promise((r) => setTimeout(r, 100));
      return makeJsonResponse({ choices: [{ message: { content: 'ok' } }], usage: { cost: 0, total_tokens: 1 } });
    };
    const agent = new Agent({ apiKey: 'sk-test' });
    setTimeout(() => ctrl.abort(), 30);
    try {
      await agent.run('go', null, { signal: ctrl.signal });
      assert.fail('expected run() to reject');
    } catch (err) {
      assert.match(err.message, /Agent run aborted/);
      assert.equal(err.aborted, true, 'expected callerAbortError(), not a bare new Error()');
    }
  });
});
