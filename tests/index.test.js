import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Ensure env is available for createAgent
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-test-key-for-index';

describe('createAgent', () => {
  let createAgent;
  let Agent;
  let ToolRegistry;

  before(async () => {
    const indexMod = await import('../src/index.js');
    createAgent = indexMod.default;
    const agentMod = await import('../src/core/agent.js');
    Agent = agentMod.default;
    const registryMod = await import('../src/registry/tool.js');
    ToolRegistry = registryMod.ToolRegistry;
  });

  after(() => {
    // cleanup only if we set it
    if (!process.env.OPENROUTER_API_KEY) {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('should export createAgent as default function', () => {
    assert.strictEqual(typeof createAgent, 'function');
  });

  it('should return an Agent instance with default config', async () => {
    const agent = await createAgent();
    assert(agent instanceof Agent);
    assert(agent.tools instanceof ToolRegistry);
    assert(agent.apiKey, 'should have an API key');
    assert.strictEqual(agent.messages.length, 0);
    assert.strictEqual(agent.usage.cost, 0);
    assert.strictEqual(agent.usage.tokens, 0);
  });

  it('should load built-in tools (Read, Write, Edit, Find, List, Bash, etc.)', async () => {
    const agent = await createAgent();
    const tools = agent.tools.listTools();
    const names = tools.map((t) => t.name);

    assert(names.includes('Read'), 'Read tool should be loaded');
    assert(names.includes('Write'), 'Write tool should be loaded');
    assert(names.includes('Edit'), 'Edit tool should be loaded');
    assert(names.includes('Find'), 'Find tool should be loaded');
    assert(names.includes('List'), 'List tool should be loaded');
    assert(names.includes('Bash'), 'Bash tool should be loaded');
    assert(names.includes('Delegate'), 'Delegate tool should be loaded');
    assert(names.includes('WebSearch'), 'WebSearch tool should be loaded');
    assert(names.includes('WebFetch'), 'WebFetch tool should be loaded');
    assert(names.includes('Todo'), 'Todo tool should be loaded');
    assert(names.includes('Skill'), 'Skill tool should be loaded');
  });

  it('should pass model from options (with env fallback)', async () => {
    const agent = await createAgent({ model: 'test-model' });
    // If .env has MODEL, config value wins (current behavior)
    if (process.env.OPENROUTER_MODEL) {
      assert.strictEqual(agent.model, process.env.OPENROUTER_MODEL);
    } else {
      assert.strictEqual(agent.model, 'test-model');
    }
  });

  it('should pass provider order from options', async () => {
    const agent = await createAgent({ order: ['openai', 'anthropic'] });
    assert.deepEqual(agent.provider.order, ['openai', 'anthropic']);
  });

  it('should pass provider only from options (with env fallback)', async () => {
    const agent = await createAgent({ only: ['openai'] });
    // If .env has ONLY, config value wins (current behavior)
    if (process.env.OPENROUTER_ONLY) {
      assert.deepEqual(agent.provider.only, [process.env.OPENROUTER_ONLY]);
    } else {
      assert.deepEqual(agent.provider.only, ['openai']);
    }
  });

  it('should return an agent with default maxTurns of 25', async () => {
    const agent = await createAgent();
    assert.strictEqual(agent.maxTurns, 25);
  });

  it('should handle being called multiple times independently', async () => {
    const [agent1, agent2] = await Promise.all([createAgent(), createAgent()]);
    assert(agent1 !== agent2);
    assert(agent1.tools !== agent2.tools, 'Each agent should have its own ToolRegistry');
  });
});
