import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('Delegate tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/system/delegate.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'Delegate');
  });

  it('should export description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('should export input_schema', () => {
    assert.ok(mod.input_schema);
    assert.strictEqual(mod.input_schema.type, 'object');
    assert.ok(mod.input_schema.properties);
    assert.ok(mod.input_schema.properties.prompt);
    assert.ok(mod.input_schema.properties.description);
    assert.ok(mod.input_schema.required.includes('prompt'));
    assert.ok(mod.input_schema.required.includes('description'));
  });

  it('should not include context_files in input_schema', () => {
    assert.strictEqual(mod.input_schema.properties.context_files, undefined);
  });

  it('should include id in input_schema as optional string', () => {
    assert.ok(mod.input_schema.properties.id);
    assert.strictEqual(mod.input_schema.properties.id.type, 'string');
    assert.ok(!mod.input_schema.required.includes('id'));
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });
});

describe('Delegate tool — execute()', () => {
  let mod;
  let Agent;

  before(async () => {
    mod = await import('../../../src/tools/system/delegate.js');
    Agent = (await import('../../../src/core/agent.js')).default;
  });

  after(() => {
    mock.reset();
  });

  it('should spawn a sub-agent and return its result with ID prefix', async () => {
    mock.method(Agent.prototype, 'run', async () => 'Sub-agent report: done');

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      maxTokens: undefined,
      subagents: new Map(),
    };

    const result = await mod.execute({ description: 'Test task', prompt: 'Do something useful' }, { agent: fakeAgent });

    assert.ok(result.startsWith('Sub-agent report: done'));
    assert.ok(result.includes('Subagent ID:'));
    assert.ok(result.includes('(new)'));
    assert.strictEqual(Agent.prototype.run.mock.calls.length, 1);
    assert.ok(fakeAgent.usage.cost >= 0);
  });

  it('should pass persona as systemPrompt to sub-agent', async () => {
    mock.method(Agent.prototype, 'run', async function () {
      return this.systemPrompt || 'no-prompt';
    });

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    const result = await mod.execute(
      { description: 'Test', prompt: 'Work', persona: 'You are a code reviewer' },
      { agent: fakeAgent },
    );

    assert.ok(result.startsWith('You are a code reviewer'));
  });

  it('should reject delegation when depth exceeds limit', async () => {
    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      _delegateDepth: 3,
      subagents: new Map(),
    };

    await assert.rejects(
      () => mod.execute({ description: 'Deep task', prompt: 'Do it' }, { agent: fakeAgent }),
      /Delegate depth limit reached/,
    );
  });

  it('should accumulate sub-agent usage into parent agent', async () => {
    mock.method(Agent.prototype, 'run', async () => {
      return 'done';
    });

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    await mod.execute({ description: 'Cost test', prompt: 'Do work' }, { agent: fakeAgent });

    assert.strictEqual(fakeAgent.usage.cost, 0);
    assert.strictEqual(fakeAgent.usage.tokens, 0);
  });

  it('should throw a wrapped error when sub-agent fails', async () => {
    mock.method(Agent.prototype, 'run', async () => {
      throw new Error('Internal failure');
    });

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    await assert.rejects(
      () => mod.execute({ description: 'Failing task', prompt: 'Do it' }, { agent: fakeAgent }),
      /Delegation failed: Internal failure/,
    );
  });

  it('should inherit parent tool registry including custom tools', async () => {
    const { ToolRegistry } = await import('../../../src/registry/tool.js');
    const parentTools = new ToolRegistry();
    parentTools.register({
      name: 'CustomTestTool',
      description: 'custom tool for testing',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'ok',
    });

    let capturedToolNames;
    mock.method(Agent.prototype, 'run', async function () {
      capturedToolNames = this.tools.listTools().map((t) => t.name);
      return 'done';
    });

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: parentTools,
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    await mod.execute({ description: 'Registry test', prompt: 'do it' }, { agent: fakeAgent });
    assert.ok(capturedToolNames.includes('CustomTestTool'));
  });

  it('should set subagent maxTurns to 1000', async () => {
    let capturedMaxTurns;
    mock.method(Agent.prototype, 'run', async function () {
      capturedMaxTurns = this.maxTurns;
      return 'done';
    });

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    await mod.execute({ description: 'MaxTurns test', prompt: 'do it' }, { agent: fakeAgent });
    assert.strictEqual(capturedMaxTurns, 1000);
  });

  it('should store new subagent in agent.subagents with auto-generated id', async () => {
    mock.method(Agent.prototype, 'run', async () => 'done');

    const fakeAgent = {
      apiKey: 'k',
      model: 'm',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    const result = await mod.execute({ description: 'd', prompt: 'p' }, { agent: fakeAgent });

    assert.strictEqual(fakeAgent.subagents.size, 1);
    const [[id]] = fakeAgent.subagents;
    assert.ok(result.includes(`Subagent ID: ${id} (new)`));
  });

  it('should reuse existing subagent when id matches', async () => {
    let callCount = 0;
    mock.method(Agent.prototype, 'run', async () => {
      callCount++;
      return `call-${callCount}`;
    });

    const fakeAgent = {
      apiKey: 'k',
      model: 'm',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    await mod.execute({ description: 'd', prompt: 'first', id: 'mybot' }, { agent: fakeAgent });
    const subagent = fakeAgent.subagents.get('mybot');
    assert.ok(subagent);

    const result2 = await mod.execute({ description: 'd', prompt: 'second', id: 'mybot' }, { agent: fakeAgent });
    assert.strictEqual(fakeAgent.subagents.size, 1);
    assert.strictEqual(fakeAgent.subagents.get('mybot'), subagent);
    assert.ok(result2.includes('Subagent ID: mybot (reused)'));
  });

  it('should only accumulate delta usage on reuse', async () => {
    mock.method(Agent.prototype, 'run', async function () {
      this.usage.cost += 0.01;
      this.usage.tokens += 100;
      return 'done';
    });

    const fakeAgent = {
      apiKey: 'k',
      model: 'm',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      subagents: new Map(),
    };

    await mod.execute({ description: 'd', prompt: 'first', id: 'bot' }, { agent: fakeAgent });
    assert.ok(Math.abs(fakeAgent.usage.cost - 0.01) < 1e-9);

    await mod.execute({ description: 'd', prompt: 'second', id: 'bot' }, { agent: fakeAgent });
    assert.ok(Math.abs(fakeAgent.usage.cost - 0.02) < 1e-9);
  });
});
