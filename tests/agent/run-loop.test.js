import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RunLoop } from '../../src/agent/run-loop.js';
import { resolveLogger } from '../../src/support/logger.js';

const silentLogger = resolveLogger({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

const noUsage = { cost: 0, tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };

// A normalized provider response, the shape RequestClient.request resolves to.
function reply({ content = null, tool_calls = null, finishReason = 'stop', reasoning, usage = noUsage } = {}) {
  return {
    message: { content, tool_calls, reasoning },
    finishReason,
    reasoning,
    reasoningDetails: undefined,
    usage,
    raw: { choices: [{ message: { content, tool_calls } }] },
  };
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function makeRequestClient(responses) {
  let index = 0;
  return {
    calls: 0,
    prompts: [],
    payloads: [],
    options: [],
    async request(payload, options) {
      this.calls += 1;
      this.payloads.push(payload);
      this.options.push(options);
      const lastUser = [...payload.messages].reverse().find((m) => m.role === 'user');
      if (lastUser) this.prompts.push(textOf(lastUser));
      const next = responses[index++] ?? responses[responses.length - 1];
      return typeof next === 'function' ? next(payload, options) : next;
    },
  };
}

function makeToolExecutor(run = async () => 'ok') {
  return {
    calls: [],
    async execute(toolCall, context) {
      this.calls.push({ toolCall, context });
      const result = await run(toolCall, context);
      if (result && typeof result === 'object' && result.role === 'tool') return result;
      return {
        role: 'tool',
        content: String(result),
        tool_call_id: toolCall.id,
        duration_ms: 1,
        richParts: [],
      };
    },
  };
}

function makeLifecycle(overrides = {}) {
  return {
    injectorCalls: [],
    stopCalls: [],
    resets: 0,
    async applyInjectors(scope, context) {
      this.injectorCalls.push({ scope, turn: context.turn });
      return [];
    },
    async resolveStop(args) {
      this.stopCalls.push(args);
      return {
        content: args.content,
        reasoning: args.reasoning,
        reasoning_details: args.reasoning_details,
        tool_calls: undefined,
        finish_reason: args.finish_reason,
      };
    },
    resetStopAttempts() {
      this.resets += 1;
    },
    ...overrides,
  };
}

function makeBackgroundJobs(pending = []) {
  return {
    pending: [...pending],
    drainExitEvents() {
      return this.pending.splice(0);
    },
    describe(id, tailBytes) {
      return `- ${id}: described(${tailBytes})`;
    },
  };
}

function makeAgent(overrides = {}) {
  const agent = {
    messages: [],
    usage: { ...noUsage },
    currentTurn: 0,
    maxTurns: 25,
    isSubagent: false,
    autoWake: false,
    maxToolOutputChars: 4096,
    logger: silentLogger,
    events: [],
    richAppends: [],
    richWindows: [],
    degraded: [],
    _recoveryHook: null,
    _multimodalUnsupported: false,
    async _buildPayload() {
      return { model: 'test/model', messages: agent.messages.map((m) => ({ ...m })) };
    },
    _dropRichContent(payload) {
      agent.degraded.push(payload);
    },
    _closeRichContentWindow(state) {
      agent.richWindows.push(state);
    },
    _appendRichContent(parts, toolIds) {
      agent.richAppends.push({ parts, toolIds });
    },
    ...overrides,
  };
  return agent;
}

function makeContext(agent, { signal, isStreaming = false, recorder = null } = {}) {
  return {
    messages: agent.messages,
    usage: agent.usage,
    get currentTurn() {
      return agent.currentTurn;
    },
    set currentTurn(turn) {
      agent.currentTurn = turn;
    },
    get maxTurns() {
      return agent.maxTurns;
    },
    get recorder() {
      return recorder;
    },
    isStreaming,
    broadcast: async (event) => {
      agent.events.push(event);
    },
    signal,
    agent,
  };
}

function makeLoop({ requestClient, toolExecutor, lifecycle, backgroundJobs } = {}) {
  return new RunLoop({
    requestClient: requestClient ?? makeRequestClient([reply({ content: 'done' })]),
    toolExecutor: toolExecutor ?? makeToolExecutor(),
    lifecycle: lifecycle ?? makeLifecycle(),
    backgroundJobs: backgroundJobs ?? makeBackgroundJobs(),
    logger: silentLogger,
  });
}

const callTool = (name, id = 'c1') =>
  reply({ tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }], finishReason: 'tool_calls' });

describe('RunLoop: queued steering', () => {
  it('applies a steer queued during the run to the next turn', async () => {
    const requestClient = makeRequestClient([reply({ content: 'first' }), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();
    const context = makeContext(agent);

    const runPromise = loop.run('start', context);
    assert.equal(loop.steer('focus on tests'), true);
    assert.equal(await runPromise, 'done');
    assert.deepEqual(requestClient.prompts, ['start', 'focus on tests']);
  });

  it('broadcasts steer_applied with the number of drained prompts', async () => {
    const requestClient = makeRequestClient([reply({ content: 'first' }), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();
    const context = makeContext(agent);

    const runPromise = loop.run('start', context);
    loop.steer('one');
    loop.steer('two');
    await runPromise;

    const steerEvents = agent.events.filter((e) => e.steer_applied);
    assert.equal(steerEvents.length, 1);
    assert.equal(steerEvents[0].steer_applied.count, 2);
  });

  it('refuses a steer when idle, and empty prompts while running', async () => {
    const requestClient = makeRequestClient([reply({ content: 'first' }), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    assert.equal(loop.steer('nothing to steer'), false);

    const runPromise = loop.run('start', makeContext(agent));
    assert.equal(loop.steer(''), false);
    assert.equal(loop.steer(null), false);
    assert.equal(loop.steer([]), false);
    assert.equal(loop.steer([{ type: 'text', text: 'structured steer' }]), true);
    await runPromise;

    assert.ok(JSON.stringify(agent.messages).includes('structured steer'));
  });

  it('keeps the loop alive when a steer lands on an empty terminal turn', async () => {
    const requestClient = makeRequestClient([reply({ content: '' }), reply({ content: 'after steer' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    const runPromise = loop.run('start', makeContext(agent));
    loop.steer('keep going');
    assert.equal(await runPromise, 'after steer');
    assert.equal(requestClient.calls, 2);
  });
});

describe('RunLoop: concurrent runs', () => {
  it('queues the prompt of a second run and returns the in-flight promise', async () => {
    const requestClient = makeRequestClient([reply({ content: 'first' }), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();
    const context = makeContext(agent);

    const first = loop.run('start', context);
    const second = loop.run('concurrent prompt', context);
    assert.equal(first, second, 'the second call must reuse the active run promise');

    assert.equal(await first, 'done');
    assert.deepEqual(requestClient.prompts, ['start', 'concurrent prompt']);
  });

  it('reports isRunning for the lifetime of the run', async () => {
    let observed;
    const toolExecutor = makeToolExecutor(async () => {
      observed = loop.isRunning;
      return 'ok';
    });
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, toolExecutor });
    const agent = makeAgent();

    assert.equal(loop.isRunning, false);
    await loop.run('start', makeContext(agent));
    assert.equal(observed, true);
    assert.equal(loop.isRunning, false);
  });
});

describe('RunLoop: tool turns', () => {
  it('runs tool calls, records their results, and continues the loop', async () => {
    const toolExecutor = makeToolExecutor();
    const lifecycle = makeLifecycle();
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, toolExecutor, lifecycle });
    const agent = makeAgent();

    assert.equal(await loop.run('start', makeContext(agent)), 'done');
    assert.equal(toolExecutor.calls.length, 1);
    assert.equal(toolExecutor.calls[0].toolCall.function.name, 'probe');

    const roles = agent.messages.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
    assert.equal(lifecycle.resets, 1, 'a tool turn clears the stop-recovery budget');

    const turnEnds = agent.events.filter((e) => e.turn_end).map((e) => e.turn_end);
    assert.deepEqual(
      turnEnds.map((t) => [t.turn, t.terminal]),
      [
        [1, false],
        [2, true],
      ],
    );
  });

  it('passes the tool context through to the executor', async () => {
    const toolExecutor = makeToolExecutor();
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, toolExecutor });
    const agent = makeAgent({ _multimodalUnsupported: true });
    const signal = new AbortController().signal;

    await loop.run('start', makeContext(agent, { signal }));
    const { context } = toolExecutor.calls[0];
    assert.equal(context.agent, agent);
    assert.equal(context.signal, signal);
    assert.equal(context.maxToolOutput, agent.maxToolOutputChars);
    assert.equal(context.multimodalUnsupported, true);
    assert.equal(typeof context.broadcast, 'function');
  });

  it('assigns ids to tool calls that arrive without one', async () => {
    const toolExecutor = makeToolExecutor();
    const requestClient = makeRequestClient([
      reply({ tool_calls: [{ function: { name: 'probe', arguments: '{}' } }] }),
      reply({ content: 'done' }),
    ]);
    const loop = makeLoop({ requestClient, toolExecutor });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.match(toolExecutor.calls[0].toolCall.id, /^call_/);
  });

  it('hands multimodal tool output to the agent', async () => {
    const richPart = { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } };
    const toolExecutor = makeToolExecutor(async (toolCall) => ({
      role: 'tool',
      content: 'image desc',
      tool_call_id: toolCall.id,
      duration_ms: 1,
      richParts: [richPart],
    }));
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, toolExecutor });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.equal(agent.richAppends.length, 1);
    assert.deepEqual(agent.richAppends[0].parts, [richPart]);
    assert.deepEqual(agent.richAppends[0].toolIds, ['c1']);
  });

  it('runs a batch of tool calls concurrently', async () => {
    let active = 0;
    let peak = 0;
    const toolExecutor = makeToolExecutor(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return 'ok';
    });
    const requestClient = makeRequestClient([
      reply({
        tool_calls: [
          { id: 'a', function: { name: 'probe', arguments: '{}' } },
          { id: 'b', function: { name: 'probe', arguments: '{}' } },
        ],
      }),
      reply({ content: 'done' }),
    ]);
    const loop = makeLoop({ requestClient, toolExecutor });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.equal(peak, 2);
    assert.deepEqual(
      agent.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
      ['a', 'b'],
    );
  });
});

describe('RunLoop: turn limits', () => {
  it('stops once maxTurns is reached', async () => {
    const requestClient = makeRequestClient([callTool('probe')]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent({ maxTurns: 3 });

    await loop.run('start', makeContext(agent));
    assert.equal(requestClient.calls, 3);
  });

  it('runs unbounded when maxTurns is 0', async () => {
    const requestClient = makeRequestClient([callTool('probe'), callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent({ maxTurns: 0 });

    assert.equal(await loop.run('start', makeContext(agent)), 'done');
    assert.equal(requestClient.calls, 3);
  });

  it('returns a LIMIT_REACHED report when a subagent runs out of turns', async () => {
    const requestClient = makeRequestClient([callTool('probe')]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent({ maxTurns: 1, isSubagent: true });

    const result = await loop.run('start', makeContext(agent));
    assert.match(result, /^\[LIMIT_REACHED\]/);
    assert.match(result, /maximum turn limit \(1\)/);
    assert.match(result, /Last tool result: ok/);
  });

  it('nudges a subagent to wrap up on its final turn', async () => {
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'summary' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent({ maxTurns: 2, isSubagent: true });

    await loop.run('start', makeContext(agent));
    const toolMessage = agent.messages.find((m) => m.role === 'tool');
    assert.match(toolMessage.content, /maximum allowed request turns/);
  });
});

describe('RunLoop: terminal turns', () => {
  it('returns an empty string for an empty terminal turn without committing a message', async () => {
    const requestClient = makeRequestClient([reply({ content: '   ' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    assert.equal(await loop.run('start', makeContext(agent)), '   ');
    assert.deepEqual(
      agent.messages.map((m) => m.role),
      ['user'],
    );
    const turnEnd = agent.events.find((e) => e.turn_end);
    assert.equal(turnEnd.turn_end.empty, true);
  });

  it('breaks out when the provider returns no message at all', async () => {
    const requestClient = makeRequestClient([{ message: undefined, usage: noUsage, raw: {} }]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();
    agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'earlier' }] });

    const result = await loop.run(null, makeContext(agent));
    assert.deepEqual(result, [{ type: 'text', text: 'earlier' }]);
    assert.equal(requestClient.calls, 1);
  });

  it('continues with a nudge when a stop hook asks to continue', async () => {
    let asked = 0;
    const lifecycle = makeLifecycle({
      async resolveStop(args) {
        this.stopCalls.push(args);
        asked += 1;
        if (asked === 1) return { continue: true, prompt: 'try again' };
        return { content: args.content, finish_reason: args.finish_reason };
      },
    });
    const requestClient = makeRequestClient([reply({ content: '' }), reply({ content: 'recovered' })]);
    const loop = makeLoop({ requestClient, lifecycle });
    const agent = makeAgent();

    assert.equal(await loop.run('start', makeContext(agent)), 'recovered');
    // An empty terminal turn commits no assistant message, so the nudge merges
    // into the trailing user message rather than starting a new one.
    assert.deepEqual(requestClient.prompts, ['start', 'start\ntry again']);
    assert.ok(agent.events.some((e) => e.stop_recovery));
  });

  it('gives the stop hooks the recovery hook and a raw resend', async () => {
    const lifecycle = makeLifecycle();
    const requestClient = makeRequestClient([reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, lifecycle });
    const recoveryHook = () => undefined;
    const agent = makeAgent({ _recoveryHook: recoveryHook });

    await loop.run('start', makeContext(agent));
    const args = lifecycle.stopCalls[0];
    assert.equal(args.recoveryHook, recoveryHook);
    assert.equal(args.turn, 1);
    assert.equal(args.messages, agent.messages);
    assert.equal(args.usage, agent.usage);

    await args.sendModelRequest(args.payload, { isStreaming: false });
    assert.equal(requestClient.calls, 2, 'the stop hook resend goes through the request client');
    assert.equal(requestClient.options[1].onDegrade, undefined, 'a raw resend does not mirror degradation');
  });
});

describe('RunLoop: background exits', () => {
  it('drains queued exits into the prompt before the first turn', async () => {
    const backgroundJobs = makeBackgroundJobs([
      { id: 'bg-1', kind: 'bash', status: 'exited', exitCode: 0, durationMs: 1200, logPath: '/tmp/a.log' },
    ]);
    const requestClient = makeRequestClient([reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, backgroundJobs });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    const [prompt] = requestClient.prompts;
    assert.match(prompt, /start/);
    assert.match(prompt, /<system-reminder>/);
    assert.match(prompt, /bg-1 \(bash\): exited, exit 0, 1\.2s, log: \/tmp\/a\.log/);
    assert.equal(agent.messages.filter((m) => m.role === 'user').length, 1, 'merged into the prompt message');
  });

  it('renders reason, custom prompt and watched job tails', async () => {
    const backgroundJobs = makeBackgroundJobs([
      {
        id: 'bg-timer',
        kind: 'timer',
        status: 'done',
        exitCode: 0,
        durationMs: 500,
        logPath: null,
        reason: 'pace check-in',
        prompt: 'resume the task',
        watch: ['bg-watched'],
        tailBytes: 256,
      },
    ]);
    const requestClient = makeRequestClient([reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, backgroundJobs });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    const [prompt] = requestClient.prompts;
    assert.match(prompt, /- resume the task/);
    assert.match(prompt, /reason: "pace check-in"/);
    assert.match(prompt, /- bg-watched: described\(256\)/);
  });

  it('drains exits that land during tool execution', async () => {
    const backgroundJobs = makeBackgroundJobs();
    const toolExecutor = makeToolExecutor(async () => {
      backgroundJobs.pending.push({
        id: 'bg-mid',
        kind: 'bash',
        status: 'exited',
        exitCode: 0,
        durationMs: 100,
        logPath: '/tmp/m.log',
      });
      return 'ok';
    });
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, toolExecutor, backgroundJobs });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.match(requestClient.prompts[1], /bg-mid/);
  });

  it('resumes a terminal turn for a late exit only when autoWake is on', async () => {
    const backgroundJobs = makeBackgroundJobs();
    const requestClient = makeRequestClient([
      () => {
        backgroundJobs.pending.push({
          id: 'bg-late',
          kind: 'bash',
          status: 'exited',
          exitCode: 0,
          durationMs: 100,
          logPath: '/tmp/l.log',
        });
        return reply({ content: 'first' });
      },
      reply({ content: 'second' }),
    ]);
    const loop = makeLoop({ requestClient, backgroundJobs });
    const agent = makeAgent({ autoWake: true });

    assert.equal(await loop.run('start', makeContext(agent)), 'second');
    assert.match(JSON.stringify(agent.messages), /bg-late/);
  });

  it('folds a late exit into history without resuming when autoWake is off', async () => {
    const backgroundJobs = makeBackgroundJobs();
    const requestClient = makeRequestClient([
      () => {
        backgroundJobs.pending.push({
          id: 'bg-late',
          kind: 'bash',
          status: 'exited',
          exitCode: 0,
          durationMs: 100,
          logPath: '/tmp/l.log',
        });
        return reply({ content: 'only' });
      },
    ]);
    const loop = makeLoop({ requestClient, backgroundJobs });
    const agent = makeAgent();

    const result = await loop.run('start', makeContext(agent));
    assert.equal(requestClient.calls, 1, 'the run ends on the terminal turn');
    assert.match(JSON.stringify(agent.messages), /bg-late/);
    // The reminder is the last message when the loop breaks, so it is what the
    // run resolves to. Long-standing behavior, kept as-is.
    assert.match(JSON.stringify(result), /Background job\(s\) exited/);
    assert.equal(agent.messages.at(-2).content, 'only');
  });
});

describe('RunLoop: injectors and payloads', () => {
  it('applies first-turn injectors only on a fresh conversation', async () => {
    const lifecycle = makeLifecycle({
      async applyInjectors(scope, context) {
        this.injectorCalls.push({ scope, turn: context.turn });
        return [`${scope} note`];
      },
    });
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, lifecycle });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.deepEqual(
      lifecycle.injectorCalls.map((c) => c.scope),
      ['first-turn', 'per-turn', 'per-turn'],
    );

    const firstUser = agent.messages[0];
    const texts = firstUser.content.map((p) => p.text);
    assert.deepEqual(texts, [
      '<system-reminder>\nfirst-turn note\n</system-reminder>',
      '<system-reminder>\nper-turn note\n</system-reminder>',
      'start',
    ]);
  });

  it('skips first-turn injectors when the conversation already has history', async () => {
    const lifecycle = makeLifecycle();
    const requestClient = makeRequestClient([reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient, lifecycle });
    const agent = makeAgent();
    agent.messages.push({ role: 'user', content: [{ type: 'text', text: 'earlier' }] });
    agent.messages.push({ role: 'assistant', content: 'earlier answer' });

    await loop.run('next', makeContext(agent));
    assert.deepEqual(
      lifecycle.injectorCalls.map((c) => c.scope),
      ['per-turn'],
    );
  });

  it('accumulates usage across turns', async () => {
    const usage = { cost: 0.5, tokens: 10, cachedTokens: 2, cacheWriteTokens: 1 };
    const requestClient = makeRequestClient([
      reply({ tool_calls: [{ id: 'c1', function: { name: 'probe', arguments: '{}' } }], usage }),
      reply({ content: 'done', usage }),
    ]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.deepEqual(agent.usage, { cost: 1, tokens: 20, cachedTokens: 4, cacheWriteTokens: 2 });
  });

  it('prefers the _sendForTest seam over the request client', async () => {
    const requestClient = makeRequestClient([reply({ content: 'network' })]);
    const loop = makeLoop({ requestClient });
    const seen = [];
    const agent = makeAgent({
      _sendForTest: async (payload) => {
        seen.push(payload);
        return {
          choices: [{ message: { content: 'stubbed', tool_calls: null } }],
          usage: { cost: 0.25, total_tokens: 4 },
        };
      },
    });

    assert.equal(await loop.run('start', makeContext(agent)), 'stubbed');
    assert.equal(requestClient.calls, 0);
    assert.equal(seen.length, 1);
    assert.equal(agent.usage.cost, 0.25);
    assert.equal(agent.usage.tokens, 4);
  });

  it('streams and announces assembled tool calls when the run has listeners', async () => {
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent, { isStreaming: true }));
    assert.equal(requestClient.options[0].stream, true);
    const announced = agent.events.find((e) => e.tool_calls);
    assert.equal(announced.tool_calls[0].function.name, 'probe');
  });

  it('closes the rich-content window after a send, and on failure', async () => {
    const failing = {
      calls: 0,
      async request() {
        this.calls += 1;
        throw new Error('network down');
      },
    };
    const agent = makeAgent();
    const okLoop = makeLoop({ requestClient: makeRequestClient([reply({ content: 'done' })]) });
    await okLoop.run('start', makeContext(agent));
    assert.deepEqual(agent.richWindows, [{ sent: true }]);

    const failAgent = makeAgent();
    const failLoop = makeLoop({ requestClient: failing });
    await assert.rejects(() => failLoop.run('start', makeContext(failAgent)), /network down/);
    assert.deepEqual(failAgent.richWindows, [{ sent: false }]);
  });

  it('mirrors a degraded payload back into the conversation', async () => {
    const requestClient = makeRequestClient([
      (payload, options) => {
        options.onDegrade(payload);
        return reply({ content: 'done' });
      },
    ]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent));
    assert.equal(agent.degraded.length, 1);
  });
});

describe('RunLoop: recording', () => {
  it('records the request, response, assistant message and snapshot of each turn', async () => {
    const recorded = [];
    const recorder = {
      request: (turn) => recorded.push(['request', turn]),
      response: (turn) => recorded.push(['response', turn]),
      recordAssistant: (turn) => recorded.push(['assistant', turn]),
      snapshot: (turn) => recorded.push(['snapshot', turn]),
    };
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    await loop.run('start', makeContext(agent, { recorder }));
    assert.deepEqual(recorded, [
      ['request', 1],
      ['response', 1],
      ['assistant', 1],
      ['snapshot', 1],
      ['request', 2],
      ['response', 2],
      ['assistant', 2],
      ['snapshot', 2],
    ]);
  });

  it('tracks the current turn on the context', async () => {
    const seen = [];
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();
    const context = makeContext(agent);
    const originalBroadcast = context.broadcast;
    context.broadcast = async (event) => {
      seen.push(agent.currentTurn);
      return originalBroadcast(event);
    };

    await loop.run('start', context);
    assert.equal(agent.currentTurn, 2);
    assert.ok(seen.includes(1) && seen.includes(2));
  });
});

describe('RunLoop: aborts', () => {
  it('refuses to start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const requestClient = makeRequestClient([reply({ content: 'done' })]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    await assert.rejects(() => loop.run('start', makeContext(agent, { signal: controller.signal })), /run aborted/);
    assert.equal(requestClient.calls, 0);
  });

  it('discards a response that lands after the caller aborted', async () => {
    const controller = new AbortController();
    const requestClient = makeRequestClient([
      () => {
        controller.abort();
        return reply({ content: 'too late' });
      },
    ]);
    const loop = makeLoop({ requestClient });
    const agent = makeAgent();

    await assert.rejects(() => loop.run('start', makeContext(agent, { signal: controller.signal })), /run aborted/);
    assert.deepEqual(
      agent.messages.map((m) => m.role),
      ['user'],
    );
  });

  it('aborts after tool execution instead of starting another turn', async () => {
    const controller = new AbortController();
    const toolExecutor = makeToolExecutor(async () => {
      controller.abort();
      return 'ok';
    });
    const requestClient = makeRequestClient([callTool('probe'), reply({ content: 'never' })]);
    const loop = makeLoop({ requestClient, toolExecutor });
    const agent = makeAgent();

    await assert.rejects(() => loop.run('start', makeContext(agent, { signal: controller.signal })), /run aborted/);
    assert.equal(requestClient.calls, 1);
  });
});
