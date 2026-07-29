import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../src/support/errors.js';

// createAgent reads this key from the environment.
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-test-key-for-index';

describe('createAgent', () => {
  let createAgent;
  let Agent;
  let ToolRegistry;

  before(async () => {
    const indexMod = await import('../src/index.js');
    createAgent = indexMod.default;
    const agentMod = await import('../src/agent/agent.js');
    Agent = agentMod.default;
    const registryMod = await import('../src/registries/tool-registry.js');
    ToolRegistry = registryMod.ToolRegistry;
  });

  after(() => {
    // Restore only the environment value owned by this test.
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

  it('validates a caller-supplied structured logger', async () => {
    await assert.rejects(createAgent({ logger: { info() {}, warn() {}, error() {} } }), ConfigError);
  });

  it('delivers redacted Agent logs to a caller logger during a run', async () => {
    const records = [];
    const logger = Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((level) => [
        level,
        (context, message) => records.push({ level, context, message }),
      ]),
    );
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: 'done', reasoning: null, tool_calls: null } }],
          usage: { cost: 0, total_tokens: 1 },
        }),
    });

    try {
      const agent = await createAgent({ logger, injectors: { date: false } });
      agent.registerInjector({
        name: 'failing-log-test',
        scope: 'per-turn',
        run: () => {
          throw new Error('Bearer hidden-token');
        },
      });

      await agent.run('go');
    } finally {
      global.fetch = originalFetch;
    }

    const record = records.find((entry) => entry.message === 'Agent injector failed');
    assert.equal(record?.level, 'warn');
    assert.equal(record?.context.component, 'lifecycle');
    assert.equal(record?.context.injector, 'failing-log-test');
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /hidden-token/);
    assert.match(serialized, /REDACTED/);
  });

  it('uses the caller logger for its per-Agent SkillRegistry without closing it', async () => {
    const records = [];
    let closed = false;
    const logger = {
      debug: (context, message) => records.push({ context, message }),
      info() {},
      warn() {},
      error() {},
      close() {
        closed = true;
      },
    };
    const agent = await createAgent({ logger, injectors: { date: false } });
    await agent.skillRegistry.discover();
    await agent.cleanup();
    assert.ok(
      records.some((record) => record.message === 'Discovered skills' && record.context.component === 'skillRegistry'),
    );
    assert.equal(closed, false);
  });

  it('loads the canonical built-in tools', async () => {
    const agent = await createAgent();
    const tools = agent.tools.listTools();
    const names = tools.map((t) => t.name);

    assert(names.includes('readFile'), 'readFile tool should be loaded');
    assert(names.includes('writeFile'), 'writeFile tool should be loaded');
    assert(names.includes('editFile'), 'editFile tool should be loaded');
    assert(names.includes('findFiles'), 'findFiles tool should be loaded');
    assert(names.includes('listFiles'), 'listFiles tool should be loaded');
    for (const name of [
      'manageTodos',
      'recallMemory',
      'fetchUrl',
      'searchWeb',
      'runShell',
      'delegateTask',
      'manageJobs',
      'loadSkill',
      'scheduleWakeup',
    ]) {
      assert(names.includes(name), `${name} tool should be loaded`);
    }
  });

  it('explicit model option wins over env config', async () => {
    const agent = await createAgent({ model: 'test-model' });
    assert.strictEqual(agent.model, 'test-model');
  });

  it('falls back to env model when no option is given', async () => {
    const agent = await createAgent();
    assert.strictEqual(agent.model, process.env.OPENROUTER_MODEL || undefined);
  });

  it('explicit baseUrl option wins over env config', async () => {
    const agent = await createAgent({ baseUrl: 'https://custom-proxy.example/api' });
    assert.strictEqual(agent.baseUrl, 'https://custom-proxy.example/api');
  });

  it('should default baseUrl to openrouter when no option or env is given', async () => {
    const agent = await createAgent();
    const expected = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    assert.strictEqual(agent.baseUrl, expected);
  });

  it('should pass provider order from options', async () => {
    const agent = await createAgent({ order: ['openai', 'anthropic'] });
    assert.deepEqual(agent.provider.order, ['openai', 'anthropic']);
  });

  it('explicit provider only option wins over env config', async () => {
    const agent = await createAgent({ only: ['openai'] });
    assert.deepEqual(agent.provider.only, ['openai']);
  });

  it('explicit apiKey option wins over env config', async () => {
    const agent = await createAgent({ apiKey: 'sk-explicit-key' });
    assert.strictEqual(agent.apiKey, 'sk-explicit-key');
  });

  it('honors a caller-supplied ToolRegistry without auto-discovery', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'OnlyMine',
      description: 'custom tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'mine',
    });
    const agent = await createAgent({ tools: registry });
    assert.strictEqual(agent.tools, registry);
    const names = agent.tools.listTools().map((t) => t.name);
    assert.deepEqual(names, ['OnlyMine'], 'builtin auto-discovery should be skipped');
  });

  it('should return an agent with maxTurns from env or default 25', async () => {
    const agent = await createAgent();
    const expectedTurns = process.env.OPENROUTER_MAX_TURNS ? parseInt(process.env.OPENROUTER_MAX_TURNS) : 25;
    assert.strictEqual(agent.maxTurns, expectedTurns);
  });

  it('should handle being called multiple times independently', async () => {
    const [agent1, agent2] = await Promise.all([createAgent(), createAgent()]);
    assert(agent1 !== agent2);
    assert(agent1.tools !== agent2.tools, 'Each agent should have its own ToolRegistry');
  });

  it('readFile executes and returns file content', async () => {
    const agent = await createAgent();
    const result = await agent.tools.execute('readFile', { path: process.cwd() + '/package.json' }, { agent });
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('openrouter'), 'result should contain openrouter from package.json');
  });

  it('listFiles executes and returns a directory listing', async () => {
    const agent = await createAgent();
    const result = await agent.tools.execute('listFiles', { path: process.cwd() }, { agent });
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('package.json') || result.includes('src'), 'result should list project files');
  });

  it('agent.registerTools() registers a callable tool', async () => {
    const agent = await createAgent();
    agent.registerTools({
      name: 'PingTool',
      description: 'test tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'pong',
    });
    const result = await agent.tools.execute('PingTool', {}, { agent });
    assert.strictEqual(result, 'pong');
  });

  it('two agents have independent tool registries', async () => {
    const [agent1, agent2] = await Promise.all([createAgent(), createAgent()]);
    agent1.registerTools({
      name: 'OnlyAgent1Tool',
      description: 'test',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'ok',
    });
    const names1 = agent1.tools.listTools().map((t) => t.name);
    const names2 = agent2.tools.listTools().map((t) => t.name);
    assert.ok(names1.includes('OnlyAgent1Tool'), 'agent1 should have the custom tool');
    assert.ok(!names2.includes('OnlyAgent1Tool'), 'agent2 should not have the custom tool');
  });
});
