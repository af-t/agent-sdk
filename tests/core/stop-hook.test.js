import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import Agent from '../../src/core/agent.js';

const NUDGE_NEEDLE = 'no response and no tool call';

function empty(reasoning = 'thinking out loud') {
  return {
    choices: [{ message: { content: null, reasoning, tool_calls: undefined }, finish_reason: 'stop' }],
    usage: { cost: 0, total_tokens: 1 },
  };
}

function text(content, finish_reason = 'stop') {
  return {
    choices: [{ message: { content, reasoning: null, tool_calls: undefined }, finish_reason }],
    usage: { cost: 0, total_tokens: 1 },
  };
}

function toolCall(name = 'Probe') {
  return {
    choices: [
      {
        message: {
          content: null,
          reasoning: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { cost: 0, total_tokens: 1 },
  };
}

// Each entry is a function returning a response (or throwing). The last entry
// repeats once the queue is exhausted.
function queue(entries) {
  const state = { calls: 0 };
  const fn = async () => {
    const entry = entries[Math.min(state.calls, entries.length - 1)];
    state.calls++;
    return entry();
  };
  fn.state = state;
  return fn;
}

function hasText(messages, needle) {
  return messages.some((m) => {
    const c = m.content;
    if (typeof c === 'string') return c.includes(needle);
    if (Array.isArray(c)) return c.some((p) => typeof p?.text === 'string' && p.text.includes(needle));
    return false;
  });
}

const assistants = (agent) => agent.messages.filter((m) => m.role === 'assistant');

describe('Agent — stop hooks & empty-turn recovery', () => {
  it('raw-retries an empty terminal turn and adopts a recovered content turn', async () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    const stub = queue([() => empty(), () => text('recovered')]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, 'recovered');
    assert.equal(stub.state.calls, 2, 'one retry after the empty turn');
    assert.equal(assistants(agent).length, 1, 'empty turn must not be committed');
    assert.equal(assistants(agent)[0].content, 'recovered');
    assert.equal(hasText(agent.messages, NUDGE_NEEDLE), false, 'no nudge when a raw retry succeeds');
  });

  it('escalates to a nudge after retries are exhausted, then adopts content', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: { retries: 1 } });
    const stub = queue([() => empty(), () => empty(), () => text('after-nudge')]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, 'after-nudge');
    assert.equal(stub.state.calls, 3, 'initial + 1 retry + 1 post-nudge turn');
    assert.equal(hasText(agent.messages, NUDGE_NEEDLE), true, 'nudge was injected');
    assert.equal(assistants(agent).at(-1).content, 'after-nudge');
  });

  it('gives up after the nudge and returns empty without a trailing assistant message', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: { retries: 0 } });
    const stub = queue([() => empty(), () => empty()]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, '');
    assert.equal(stub.state.calls, 2, 'initial + post-nudge turn, then give up');
    assert.equal(assistants(agent).length, 0, 'no empty assistant committed');
    assert.equal(agent.messages.at(-1).role, 'user', 'history ends on a user message (continuation-safe)');
    assert.equal(hasText(agent.messages, NUDGE_NEEDLE), true);
  });

  it('treats a 400 on a retry as an escalation to the nudge', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: { retries: 2 } });
    const stub = queue([
      () => empty(),
      () => {
        throw Object.assign(new Error('bad request'), { status: 400 });
      },
      () => text('recovered'),
    ]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, 'recovered');
    assert.equal(stub.state.calls, 3);
    assert.equal(hasText(agent.messages, NUDGE_NEEDLE), true, 'a 400 retry escalates to the nudge');
  });

  it('leaves a non-empty terminal turn untouched', async () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    const stub = queue([() => text('hello')]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, 'hello');
    assert.equal(stub.state.calls, 1, 'no recovery for a normal completion');
    assert.equal(assistants(agent).at(-1).content, 'hello');
  });

  it('does nothing when recovery is disabled (single call, no commit of empty turn)', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: false });
    const stub = queue([() => empty(), () => text('should-not-reach')]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, '');
    assert.equal(stub.state.calls, 1, 'recovery disabled => no retry');
    assert.equal(assistants(agent).length, 0);
  });

  it('runs a custom onStop hook before the built-in recovery (continue wins over retry)', async () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    agent.onStop(({ attempt }) => (attempt === 0 ? { action: 'continue', prompt: 'CUSTOM-NUDGE' } : undefined));
    const stub = queue([() => empty(), () => text('ok')]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, 'ok');
    assert.equal(stub.state.calls, 2);
    assert.equal(hasText(agent.messages, 'CUSTOM-NUDGE'), true, 'custom hook took precedence over built-in retry');
  });

  it('is bounded by the recovery ceiling when a hook always retries', async () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    agent.onStop(() => ({ action: 'retry' }));
    const stub = queue([() => empty()]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, '');
    assert.ok(stub.state.calls <= 12, `recovery must be bounded, got ${stub.state.calls} calls`);
    assert.ok(stub.state.calls >= 2, 'at least one retry happened');
  });

  it('resets the recovery budget after a successful tool turn', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: { retries: 1 } });
    agent.use({
      name: 'Probe',
      description: 'probe',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'probed',
    });
    // empty -> retry -> empty -> nudge -> tool turn -> empty -> retry -> content
    const stub = queue([() => empty(), () => empty(), () => toolCall('Probe'), () => empty(), () => text('done')]);
    agent._sendForTest = stub;

    const result = await agent.run('hi');

    assert.equal(result, 'done');
    // The post-tool empty turn gets a fresh retry budget (proves the reset).
    assert.equal(stub.state.calls, 5);
  });

  it('stops issuing recovery retries once the run signal aborts mid-recovery', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: { retries: 5 } });
    const controller = new AbortController();
    const stub = queue([
      () => empty(), // initial terminal empty turn -> recovery starts
      () => {
        // first retry resolves, but the run is aborted as a side effect
        controller.abort();
        return empty();
      },
      () => text('should-not-be-reached'), // a further retry must NOT run
    ]);
    agent._sendForTest = stub;

    const result = await agent.run('hi', undefined, { signal: controller.signal });

    assert.equal(result, '');
    assert.equal(stub.state.calls, 2, 'no new retry after the abort is observed');
    assert.equal(assistants(agent).length, 0, 'empty turn not committed on abort');
    assert.equal(hasText(agent.messages, NUDGE_NEEDLE), false, 'aborted before any nudge');
  });
});

describe('Agent — finish_reason capture (streaming SSE)', () => {
  let originalFetch;
  before(() => {
    originalFetch = global.fetch;
  });
  after(() => {
    global.fetch = originalFetch;
  });

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

  it('captures finish_reason from the final SSE chunk into turn_end', async () => {
    global.fetch = async () =>
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":null}',
        'data: [DONE]',
      ]);

    const agent = new Agent({ apiKey: 'sk-test' });
    const ends = [];
    agent.subscribe((e) => {
      if (e.turn_end) ends.push(e.turn_end);
    });

    const result = await agent.run('go');

    assert.equal(result, 'hi');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].terminal, true);
    assert.equal(ends[0].finish_reason, 'length');
  });

  it('drives empty-turn recovery in streaming mode too', async () => {
    const agent = new Agent({ apiKey: 'sk-test', emptyTurnRecovery: { retries: 1 } });
    const ends = [];
    agent.subscribe((e) => {
      if (e.turn_end) ends.push(e.turn_end);
    });
    // subscribe() forces streaming; _sendForTest is honored by #sendStream.
    const stub = queue([() => empty(), () => text('streamed')]);
    agent._sendForTest = stub;

    const result = await agent.run('go');

    assert.equal(result, 'streamed');
    assert.equal(stub.state.calls, 2, 'streaming recovery retried the empty turn');
  });
});
