import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

function makeJsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text };
}

// First call returns a single tool_call with the given raw arguments string,
// second call returns final content. Mirrors the no-argument tool case where a
// streaming model emits an empty arguments string.
function llmStubWithArgs(rawArgs) {
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
              tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'NoArgs', arguments: rawArgs } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 10 },
      });
    }
    return makeJsonResponse({
      choices: [{ message: { content: 'done', reasoning: null, tool_calls: null } }],
      usage: { cost: 0, total_tokens: 5 },
    });
  };
}

describe('Agent — empty tool arguments (zero-parameter tools)', () => {
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

  for (const [label, rawArgs] of [
    ['empty string', ''],
    ['whitespace only', '   '],
    ['missing/undefined', undefined],
  ]) {
    it(`executes a no-arg tool when arguments are ${label}`, async () => {
      global.fetch = llmStubWithArgs(rawArgs);
      let executed = false;
      let receivedInput;
      const agent = new Agent({ apiKey: 'sk-test' });
      agent.use({
        name: 'NoArgs',
        description: 'takes no arguments',
        input_schema: { type: 'object', properties: {}, required: [] },
        execute: async (input) => {
          executed = true;
          receivedInput = input;
          return 'ok';
        },
      });

      const out = await agent.run('go');
      assert.equal(executed, true, 'zero-parameter tool should execute even with empty arguments');
      assert.deepEqual(receivedInput, {}, 'empty arguments should parse to an empty object');
      assert.equal(out, 'done');
    });
  }
});
