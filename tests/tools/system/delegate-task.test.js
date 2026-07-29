import { describe, it, before, after, mock } from 'node:test';
/* eslint-disable prefer-const */
import assert from 'node:assert/strict';

import { createTestTempDir } from '../../support/temp.js';
import { ToolRegistry } from '../../../src/registries/tool-registry.js';
import { resolveLogger } from '../../../src/support/logger.js';

const noopLogger = resolveLogger(
  Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, () => {}])),
);

function makeStreamResponse(content) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body };
}

function createFakeAgent(t, overrides = {}) {
  const subagents = new Map();
  t.after(async () => {
    await Promise.all([...subagents.values()].map((subagent) => subagent.cleanup()));
    subagents.clear();
  });
  const tmpDir = createTestTempDir(t, 'delegate-fake-parent-');

  return {
    apiKey: 'sk-test-key',
    model: 'test-model',
    provider: {},
    tools: new ToolRegistry({ logger: noopLogger }),
    usage: { cost: 0, tokens: 0 },
    subagents,
    _storagePaths: { tmpDir },
    logger: noopLogger,
    ...overrides,
  };
}

describe('delegateTask tool module', () => {
  let mod;

  before(async () => {
    mod = (await import('../../../src/tools/system/delegate-task.js')).delegateTask;
  });

  it('exports delegateTask as a strict tool object', () => {
    assert.strictEqual(mod.name, 'delegateTask');
    assert.strictEqual(mod.inputSchema.additionalProperties, false);
  });

  it('describes itself with a non-empty description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('declares an object input schema', () => {
    assert.ok(mod.inputSchema);
    assert.strictEqual(mod.inputSchema.type, 'object');
    assert.ok(mod.inputSchema.properties);
    assert.ok(mod.inputSchema.properties.prompt);
    assert.ok(mod.inputSchema.properties.description);
    assert.ok(mod.inputSchema.required.includes('prompt'));
    assert.ok(mod.inputSchema.required.includes('description'));
  });

  it('does not expose a context_files parameter', () => {
    assert.strictEqual(mod.inputSchema.properties.context_files, undefined);
  });

  it('accepts an optional string id', () => {
    assert.ok(mod.inputSchema.properties.id);
    assert.strictEqual(mod.inputSchema.properties.id.type, 'string');
    assert.ok(!mod.inputSchema.required.includes('id'));
  });

  it('exposes execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });
});

describe('delegateTask execution', () => {
  let mod;
  let Agent;

  before(async () => {
    mod = (await import('../../../src/tools/system/delegate-task.js')).delegateTask;
    Agent = (await import('../../../src/agent/agent.js')).default;
  });

  after(() => {
    mock.reset();
  });

  it('spawns a sub-agent and returns its report with the subagent ID footer', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'Sub-agent report: done');

    const fakeAgent = createFakeAgent(t, { maxCompletionTokens: undefined });

    const result = await mod.execute({ description: 'Test task', prompt: 'Do something useful' }, { agent: fakeAgent });

    assert.ok(result.startsWith('Sub-agent report: done'));
    assert.ok(result.includes('Subagent ID:'));
    assert.ok(result.includes('(new)'));
    assert.strictEqual(Agent.prototype.run.mock.calls.length, 1);
    assert.ok(fakeAgent.usage.cost >= 0);
  });

  it('subagent inherits parent maxCompletionTokens', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'done');

    let parent;
    t.after(() => parent?.cleanup());
    const tmpDir = createTestTempDir(t, 'delegate-parent-');
    parent = new Agent({ apiKey: 'sk-test-key', maxCompletionTokens: 4096, storagePaths: { tmpDir } });
    await mod.execute({ description: 'Task', prompt: 'Work' }, { agent: parent });

    const sub = [...parent.subagents.values()][0];
    assert.strictEqual(sub.maxCompletionTokens, 4096);
    assert.strictEqual(sub.maxTokens, undefined);
  });

  it('subagent keeps the parent transport injection', async (t) => {
    while (Agent.prototype.run.mock) Agent.prototype.run.mock.restore();
    const tmpDir = createTestTempDir(t, 'delegate-transport-');
    let calls = 0;
    const parent = new Agent({
      apiKey: 'sk-test-key',
      storagePaths: { tmpDir },
      transport: async () => {
        calls += 1;
        return makeStreamResponse('delegated response');
      },
    });
    t.after(() => parent.cleanup());
    const originalFetch = global.fetch;
    let globalCalls = 0;
    global.fetch = async () => {
      globalCalls += 1;
      return makeStreamResponse('global response');
    };
    t.after(() => {
      global.fetch = originalFetch;
    });

    const result = await mod.execute({ description: 'Task', prompt: 'Work', id: 'transport-child' }, { agent: parent });
    assert.match(result, /^delegated response/);
    assert.equal(calls, 1);
    assert.equal(globalCalls, 0);
  });

  it('uses the parent SkillRegistry with isolated tool definitions', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'done');
    const createAgent = (await import('../../../src/index.js')).default;
    const parent = await createAgent({ apiKey: 'sk-test-key' });
    t.after(() => parent.cleanup());
    await parent.skillRegistry._ensureDiscovered();
    parent.skillRegistry.skills.set('delegate-marker', {
      description: 'shared marker',
      content: 'delegate marker body.',
    });

    await mod.execute({ description: 'Task', prompt: 'Work', id: 'shared-skills' }, { agent: parent });
    const child = parent.subagents.get('shared-skills');
    assert.equal(child.skillRegistry, parent.skillRegistry);
    assert.notEqual(child.tools, parent.tools);
    assert.match(
      await child.tools.execute('loadSkill', { action: 'load', argument: 'delegate-marker' }, { agent: child }),
      /delegate marker body/,
    );
    child.registerTools({
      name: 'ChildOnly',
      description: 'Only the child can call this tool.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'child',
    });
    assert.ok(!parent.tools.listTools().some((tool) => tool.name === 'ChildOnly'));
  });

  it('subagent defaults maxCompletionTokens to MAX_COMPLETION_TOKENS_SUBAGENT', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'done');

    let parent;
    t.after(() => parent?.cleanup());
    const tmpDir = createTestTempDir(t, 'delegate-parent-');
    parent = new Agent({ apiKey: 'sk-test-key', storagePaths: { tmpDir } });
    // Clearing the parent's limit exposes the subagent's fallback. Otherwise,
    // the parent may inherit OPENROUTER_MAX_COMPLETION_TOKENS from the
    // developer's environment.
    parent.maxCompletionTokens = undefined;
    await mod.execute({ description: 'Task', prompt: 'Work' }, { agent: parent });

    const sub = [...parent.subagents.values()][0];
    assert.strictEqual(sub.maxCompletionTokens, 32000);
  });

  it('passes persona to the sub-agent as its systemPrompt', async (t) => {
    mock.method(Agent.prototype, 'run', async function () {
      return this.systemPrompt || 'no-prompt';
    });

    const fakeAgent = createFakeAgent(t);

    const result = await mod.execute(
      { description: 'Test', prompt: 'Work', persona: 'You are a code reviewer' },
      { agent: fakeAgent },
    );

    assert.ok(result.startsWith('You are a code reviewer'));
  });

  it('propagates _delegateDepth to spawned subagents', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'done');

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    await mod.execute({ description: 'd', prompt: 'p', id: 'child' }, { agent: fakeAgent });
    assert.strictEqual(fakeAgent.subagents.get('child')._delegateDepth, 1);
  });

  it('rejects nested delegation once the depth limit is reached', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'done');

    let parent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    // Real subagents create a three-level delegation chain.
    for (let i = 0; i < 3; i++) {
      await mod.execute({ description: 'd', prompt: 'p', id: 'sub' }, { agent: parent });
      parent = parent.subagents.get('sub');
    }
    assert.strictEqual(parent._delegateDepth, 3);

    await assert.rejects(
      () => mod.execute({ description: 'd', prompt: 'p' }, { agent: parent }),
      /delegateTask depth limit reached/,
    );
  });

  it('rejects delegation once the depth limit is exceeded', async (t) => {
    const fakeAgent = createFakeAgent(t, { _delegateDepth: 3 });

    await assert.rejects(
      () => mod.execute({ description: 'Deep task', prompt: 'Do it' }, { agent: fakeAgent }),
      /delegateTask depth limit reached/,
    );
  });

  it('accumulates sub-agent usage into the parent agent', async (t) => {
    mock.method(Agent.prototype, 'run', async () => {
      return 'done';
    });

    const fakeAgent = createFakeAgent(t);

    await mod.execute({ description: 'Cost test', prompt: 'Do work' }, { agent: fakeAgent });

    assert.strictEqual(fakeAgent.usage.cost, 0);
    assert.strictEqual(fakeAgent.usage.tokens, 0);
  });

  it('wraps a failing sub-agent run in a delegation error', async (t) => {
    mock.method(Agent.prototype, 'run', async () => {
      throw new Error('Internal failure');
    });

    const fakeAgent = createFakeAgent(t);

    await assert.rejects(
      () => mod.execute({ description: 'Failing task', prompt: 'Do it' }, { agent: fakeAgent }),
      /Delegation failed: Internal failure/,
    );
  });

  it('inherits the parent tool registry including custom tools', async (t) => {
    const parentTools = new ToolRegistry();
    parentTools.register({
      name: 'CustomTestTool',
      description: 'custom tool for testing',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'ok',
    });

    let capturedToolNames;
    mock.method(Agent.prototype, 'run', async function () {
      capturedToolNames = this.tools.listTools().map((t) => t.name);
      return 'done';
    });

    const fakeAgent = createFakeAgent(t, { tools: parentTools });

    await mod.execute({ description: 'Registry test', prompt: 'do it' }, { agent: fakeAgent });
    assert.ok(capturedToolNames.includes('CustomTestTool'));
  });

  it('sets the subagent maxTurns to 1000', async (t) => {
    let capturedMaxTurns;
    mock.method(Agent.prototype, 'run', async function () {
      capturedMaxTurns = this.maxTurns;
      return 'done';
    });

    const fakeAgent = createFakeAgent(t);

    await mod.execute({ description: 'MaxTurns test', prompt: 'do it' }, { agent: fakeAgent });
    assert.strictEqual(capturedMaxTurns, 1000);
  });

  it('stores a new subagent in agent.subagents under an auto-generated id', async (t) => {
    mock.method(Agent.prototype, 'run', async () => 'done');

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    const result = await mod.execute({ description: 'd', prompt: 'p' }, { agent: fakeAgent });

    assert.strictEqual(fakeAgent.subagents.size, 1);
    const [[id]] = fakeAgent.subagents;
    assert.ok(result.includes(`Subagent ID: ${id} (new)`));
  });

  it('reuses an existing subagent when the id matches', async (t) => {
    let callCount = 0;
    mock.method(Agent.prototype, 'run', async () => {
      callCount++;
      return `call-${callCount}`;
    });

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    await mod.execute({ description: 'd', prompt: 'first', id: 'mybot' }, { agent: fakeAgent });
    const subagent = fakeAgent.subagents.get('mybot');
    assert.ok(subagent);

    const result2 = await mod.execute({ description: 'd', prompt: 'second', id: 'mybot' }, { agent: fakeAgent });
    assert.strictEqual(fakeAgent.subagents.size, 1);
    assert.strictEqual(fakeAgent.subagents.get('mybot'), subagent);
    assert.ok(result2.includes('Subagent ID: mybot (reused)'));
  });

  it('short-circuits when the signal is pre-aborted', async (t) => {
    const controller = new AbortController();
    controller.abort();

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    await assert.rejects(
      () => mod.execute({ description: 'd', prompt: 'p' }, { agent: fakeAgent, signal: controller.signal }),
      /delegateTask aborted/,
    );

    // Aborting before execution prevents subagent creation.
    assert.strictEqual(fakeAgent.subagents.size, 0);
  });

  it('forwards the signal to subagent.run', async (t) => {
    const controller = new AbortController();
    let capturedOpts;

    mock.method(Agent.prototype, 'run', async function (prompt, notify, opts) {
      capturedOpts = opts;
      return 'done';
    });

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    await mod.execute({ description: 'd', prompt: 'p' }, { agent: fakeAgent, signal: controller.signal });

    assert.ok(capturedOpts);
    assert.strictEqual(capturedOpts.signal, controller.signal);
  });

  it('rejects when the parent signal aborts mid-run', async (t) => {
    const controller = new AbortController();

    mock.method(Agent.prototype, 'run', async function (prompt, notify, opts) {
      // Agent.run checks the signal again during execution.
      const signal = opts?.signal;
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal?.aborted) throw new Error('Agent run aborted');
      return 'should not reach';
    });

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    await assert.rejects(
      () => mod.execute({ description: 'd', prompt: 'p' }, { agent: fakeAgent, signal: controller.signal }),
      /Delegation failed: Agent run aborted/,
    );
  });

  it('accumulates only delta usage when a subagent is reused', async (t) => {
    mock.method(Agent.prototype, 'run', async function () {
      this.usage.cost += 0.01;
      this.usage.tokens += 100;
      return 'done';
    });

    const fakeAgent = createFakeAgent(t, { apiKey: 'k', model: 'm' });

    await mod.execute({ description: 'd', prompt: 'first', id: 'bot' }, { agent: fakeAgent });
    assert.ok(Math.abs(fakeAgent.usage.cost - 0.01) < 1e-9);

    await mod.execute({ description: 'd', prompt: 'second', id: 'bot' }, { agent: fakeAgent });
    assert.ok(Math.abs(fakeAgent.usage.cost - 0.02) < 1e-9);
  });
});
