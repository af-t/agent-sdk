import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('Agent', () => {
  let Agent;
  let ToolRegistry;

  before(async () => {
    // We'll import with key present since env always has it
    const agentMod = await import('../../src/core/agent.js');
    Agent = agentMod.default;
    const registryMod = await import('../../src/registry/tool.js');
    ToolRegistry = registryMod.ToolRegistry;
  });

  describe('constructor', () => {
    it('accepts apiKey option', () => {
      const agent = new Agent({ apiKey: 'sk-test-key' });
      assert.ok(agent);
      assert.equal(agent.apiKey, 'sk-test-key');
    });

    it('sets default values', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      assert.ok(agent.tools instanceof ToolRegistry);
      assert.equal(typeof agent.usage, 'object');
      assert.equal(agent.usage.cost, 0);
      assert.equal(agent.usage.tokens, 0);
      assert.equal(agent.reasoningEffort, 'high');
      assert.equal(agent.maxTurns, 25);
      assert.ok(Array.isArray(agent.messages));
      assert.equal(agent.messages.length, 0);
    });

    it('accepts model option', () => {
      const agent = new Agent({ apiKey: 'sk-key', model: 'gpt-4' });
      assert.equal(agent.model, 'gpt-4');
    });

    it('accepts provider order and only options', () => {
      const agent = new Agent({
        apiKey: 'sk-key',
        order: ['openai', 'anthropic'],
        only: ['openai'],
      });
      assert.deepEqual(agent.provider.order, ['openai', 'anthropic']);
      assert.deepEqual(agent.provider.only, ['openai']);
    });

    it('accepts reasoningEffort option', () => {
      const agent = new Agent({ apiKey: 'sk-key', reasoningEffort: 'low' });
      assert.equal(agent.reasoningEffort, 'low');
    });

    it('default reasoningEffort is high', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      assert.equal(agent.reasoningEffort, 'high');
    });

    it('accepts maxTurns option', () => {
      const agent = new Agent({ apiKey: 'sk-key', maxTurns: 5 });
      assert.equal(agent.maxTurns, 5);
    });

    it('sets maxTurns to 0 for unlimited (subagent case)', () => {
      const agent = new Agent({ apiKey: 'sk-key', maxTurns: 0 });
      assert.equal(agent.maxTurns, 0);
    });

    it('accepts systemPrompt option', () => {
      const agent = new Agent({ apiKey: 'sk-key', systemPrompt: 'Custom prompt' });
      assert.equal(agent.systemPrompt, 'Custom prompt');
    });

    it('accepts pre-existing ToolRegistry via tools option', () => {
      const registry = new ToolRegistry();
      const agent = new Agent({ apiKey: 'sk-key', tools: registry });
      assert.equal(agent.tools, registry);
    });
  });

  describe('use()', () => {
    it('registers a single tool', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      const tool = {
        name: 'my_tool',
        description: 'My custom tool',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'done',
      };
      agent.use(tool);
      const tools = agent.tools.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'my_tool');
    });

    it('registers multiple tools from an array', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      const tools = [
        { name: 'a', description: '', input_schema: {}, execute: async () => {} },
        { name: 'b', description: '', input_schema: {}, execute: async () => {} },
      ];
      agent.use(tools);
      assert.equal(agent.tools.listTools().length, 2);
    });
  });

  describe('usage tracking', () => {
    it('initializes usage with cost and tokens at 0', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      assert.deepEqual(agent.usage, { cost: 0, tokens: 0 });
    });

    it('usage is mutable (cost and tokens can be incremented)', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      agent.usage.cost += 0.5;
      agent.usage.tokens += 150;
      assert.equal(agent.usage.cost, 0.5);
      assert.equal(agent.usage.tokens, 150);
    });
  });

  describe('apiKey getter', () => {
    it('returns the apiKey (read-only accessor)', () => {
      const agent = new Agent({ apiKey: 'sk-secret-123' });
      assert.equal(agent.apiKey, 'sk-secret-123');
    });
  });

  describe('reset()', () => {
    it('clears messages and resets usage to zero', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      agent.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
      agent.usage = { cost: 1.5, tokens: 500 };
      agent.reset();
      assert.deepEqual(agent.messages, []);
      assert.deepEqual(agent.usage, { cost: 0, tokens: 0 });
    });
  });
});
