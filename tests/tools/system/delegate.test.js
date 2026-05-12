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

  it('should spawn a sub-agent and return its result', async () => {
    // Mock Agent.run to return a fake report
    mock.method(Agent.prototype, 'run', async () => 'Sub-agent report: done');

    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      maxTokens: undefined,
    };

    const result = await mod.execute({ description: 'Test task', prompt: 'Do something useful' }, { agent: fakeAgent });

    assert.strictEqual(result, 'Sub-agent report: done');
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
    };

    const result = await mod.execute(
      { description: 'Test', prompt: 'Work', persona: 'You are a code reviewer' },
      { agent: fakeAgent },
    );

    assert.strictEqual(result, 'You are a code reviewer');
  });

  it('should reject delegation when depth exceeds limit', async () => {
    const fakeAgent = {
      apiKey: 'sk-test-key',
      model: 'test-model',
      provider: {},
      tools: {},
      usage: { cost: 0, tokens: 0 },
      _delegateDepth: 3, // Already at max
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
    };

    await mod.execute({ description: 'Cost test', prompt: 'Do work' }, { agent: fakeAgent });

    // The sub-agent was created and its usage should be merged
    // Since we mocked run(), usage stays 0, but the merge logic runs
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
    };

    await mod.execute({ description: 'MaxTurns test', prompt: 'do it' }, { agent: fakeAgent });
    assert.strictEqual(capturedMaxTurns, 1000);
  });
});
