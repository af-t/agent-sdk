import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { CONSTANTS } from '../../src/core/utils.js';

function makeSseResponse(lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n'));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

function makeJsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text };
}

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
      assert.equal(agent.effort, 'high');
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

    it('accepts effort option', () => {
      const agent = new Agent({ apiKey: 'sk-key', effort: 'low' });
      assert.equal(agent.effort, 'low');
    });

    it('default effort is high', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      assert.equal(agent.effort, 'high');
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

    it('defaults maxToolOutputChars to CONSTANTS.MAX_TOOL_OUTPUT', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      assert.strictEqual(agent.maxToolOutputChars, CONSTANTS.MAX_TOOL_OUTPUT);
    });

    it('accepts maxToolOutputChars override', () => {
      const agent = new Agent({ apiKey: 'sk-key', maxToolOutputChars: 1000 });
      assert.strictEqual(agent.maxToolOutputChars, 1000);
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

  describe('fileState', () => {
    it('initializes fileState as an empty Map and currentTurn to 0', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      assert.ok(agent.fileState instanceof Map);
      assert.equal(agent.fileState.size, 0);
      assert.equal(agent.currentTurn, 0);
    });

    it('reset() clears fileState and resets currentTurn', () => {
      const agent = new Agent({ apiKey: 'sk-key' });
      agent.fileState.set('/tmp/foo', { hash: 'x', lastReadTurn: 2, rangesRead: [[1, 10]], totalLines: 10 });
      agent.currentTurn = 4;
      agent.reset();
      assert.equal(agent.fileState.size, 0);
      assert.equal(agent.currentTurn, 0);
    });
  });
});

describe('run() — non-streaming (no notify)', () => {
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

  it('returns assistant content when no notify is passed', async () => {
    global.fetch = async () =>
      makeJsonResponse({
        choices: [{ message: { content: 'Hello!', reasoning: null, tool_calls: undefined } }],
        usage: { cost: 0.001, total_tokens: 50 },
      });

    const agent = new Agent({ apiKey: 'sk-test' });
    const result = await agent.run('Hi');
    assert.strictEqual(result, 'Hello!');
  });

  it('accumulates usage on non-streaming run', async () => {
    global.fetch = async () =>
      makeJsonResponse({
        choices: [{ message: { content: 'ok', reasoning: null, tool_calls: undefined } }],
        usage: { cost: 0.002, total_tokens: 80 },
      });

    const agent = new Agent({ apiKey: 'sk-test' });
    await agent.run('test');
    assert.ok(agent.usage.cost > 0);
    assert.ok(agent.usage.tokens > 0);
  });
});

describe('run() — streaming (with notify)', () => {
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

  it('calls notify with content_delta and accumulated content per chunk', async () => {
    global.fetch = async () =>
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"hel"}}],"usage":null}',
        'data: {"choices":[{"delta":{"content":"lo"}}],"usage":null}',
        'data: [DONE]',
      ]);

    const agent = new Agent({ apiKey: 'sk-test' });
    const calls = [];
    const result = await agent.run('hi', (data) => calls.push(data));

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].content_delta, 'hel');
    assert.strictEqual(calls[0].content, 'hel');
    assert.strictEqual(calls[1].content_delta, 'lo');
    assert.strictEqual(calls[1].content, 'hello');
    assert.strictEqual(result, 'hello');
  });

  it('assembles tool_calls from multi-chunk stream and notifies once', async () => {
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return makeSseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Echo","arguments":"{\\"msg\\":\\"hi\\"}"}}]}}],"usage":null}',
          'data: [DONE]',
        ]);
      }
      return makeSseResponse(['data: {"choices":[{"delta":{"content":"done"}}],"usage":null}', 'data: [DONE]']);
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    agent.use({
      name: 'Echo',
      description: 'echo the message',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      execute: async ({ msg }) => msg,
    });

    const calls = [];
    await agent.run('run something', (data) => calls.push(data));

    const tcCall = calls.find((c) => c.tool_calls);
    assert.ok(tcCall, 'Expected a notify call with tool_calls');
    assert.strictEqual(tcCall.tool_calls[0].id, 'call_1');
    assert.strictEqual(tcCall.tool_calls[0].function.name, 'Echo');
    assert.strictEqual(tcCall.tool_calls[0].function.arguments, '{"msg":"hi"}');
  });

  it('stops parsing after [DONE] — no extra notify calls', async () => {
    global.fetch = async () =>
      makeSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
        'data: [DONE]',
        'data: {"choices":[{"delta":{"content":"EXTRA"}}],"usage":null}',
      ]);

    const agent = new Agent({ apiKey: 'sk-test' });
    const calls = [];
    await agent.run('test', (data) => calls.push(data));
    const contentCalls = calls.filter((c) => c.content_delta);
    assert.strictEqual(contentCalls.length, 1);
    assert.strictEqual(contentCalls[0].content_delta, 'hi');
  });

  it('throws ApiError on non-ok streaming response', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Unauthorized' } }),
    });

    const agent = new Agent({ apiKey: 'sk-test' });
    await assert.rejects(() => agent.run('hi', () => {}), /Unauthorized|401/);
  });
});

describe('run() — maxTurns enforcement', () => {
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

  it('stops after maxTurns loop iterations and returns last tool result', async () => {
    let fetchCallCount = 0;
    global.fetch = async () => {
      fetchCallCount++;
      return makeJsonResponse({
        choices: [
          {
            message: {
              content: null,
              reasoning: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Loop', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 10 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test', maxTurns: 2 });
    agent.use({
      name: 'Loop',
      description: 'loops',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => 'looped',
    });

    const result = await agent.run('start');
    assert.strictEqual(fetchCallCount, 2);
    assert.strictEqual(result, 'looped');
  });
});

describe('run() — cache_control placement', () => {
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

  it('adds cache_control to system message and user message copies, not original', async () => {
    let capturedPayload;
    global.fetch = async (_url, opts) => {
      capturedPayload = JSON.parse(opts.body);
      return makeJsonResponse({
        choices: [{ message: { content: 'ok', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 5 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    await agent.run('hello');

    // System message always has cache_control on its content item
    const sysMsg = capturedPayload.messages[0];
    assert.strictEqual(sysMsg.role, 'system');
    assert.deepEqual(sysMsg.content[0].cache_control, { type: 'ephemeral' });

    // Last user message last content part has cache_control in the payload copy
    const userMsg = capturedPayload.messages.find((m) => m.role === 'user');
    const lastPart = userMsg.content[userMsg.content.length - 1];
    assert.deepEqual(lastPart.cache_control, { type: 'ephemeral' });

    // Original agent.messages do NOT have cache_control (added on copies only)
    const origUser = agent.messages.find((m) => m.role === 'user');
    assert.strictEqual(origUser.content[0].cache_control, undefined);
  });
});

describe('run() — AbortSignal', () => {
  let Agent;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
  });

  it('throws "Agent run aborted" when signal is already aborted before run()', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const agent = new Agent({ apiKey: 'sk-test' });
    await assert.rejects(() => agent.run('hello', null, { signal: ctrl.signal }), /Agent run aborted/);
  });
});

describe('run() — message accumulation and reset', () => {
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

  it('appends messages across multiple run() calls', async () => {
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      return makeJsonResponse({
        choices: [{ message: { content: `response ${callCount}`, reasoning: null, tool_calls: null } }],
        usage: { cost: 0.001, total_tokens: 10 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    const r1 = await agent.run('turn 1');
    assert.strictEqual(r1, 'response 1');
    const afterFirst = agent.messages.length;
    assert.ok(afterFirst >= 2, 'should have at least user + assistant after first run');

    const r2 = await agent.run('turn 2');
    assert.strictEqual(r2, 'response 2');
    assert.ok(agent.messages.length > afterFirst, 'messages should grow after second run');
  });

  it('reset() clears messages and zeroes usage', async () => {
    global.fetch = async () =>
      makeJsonResponse({
        choices: [{ message: { content: 'hi', reasoning: null, tool_calls: null } }],
        usage: { cost: 0.001, total_tokens: 10 },
      });

    const agent = new Agent({ apiKey: 'sk-test' });
    await agent.run('hello');
    assert.ok(agent.messages.length > 0);
    assert.ok(agent.usage.cost > 0);

    agent.reset();
    assert.strictEqual(agent.messages.length, 0);
    assert.strictEqual(agent.usage.cost, 0);
    assert.strictEqual(agent.usage.tokens, 0);
  });
});

describe('Agent — storagePaths option', () => {
  let Agent;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
  });

  it('storagePaths.memoryDir sets _memoryDir to resolved absolute path', () => {
    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { memoryDir: '~/.config/test/memory' } });
    assert.ok(path.isAbsolute(agent._memoryDir));
    assert.ok(agent._memoryDir.endsWith(path.join('.config', 'test', 'memory')));
  });

  it('storagePaths.memoryDir takes precedence over legacy memoryDir option', () => {
    const agent = new Agent({
      apiKey: 'sk-test',
      memoryDir: '.old/memory',
      storagePaths: { memoryDir: '~/.config/new/memory' },
    });
    assert.ok(agent._memoryDir.includes(path.join('.config', 'new', 'memory')));
  });

  it('legacy memoryDir still works when storagePaths is absent', () => {
    const agent = new Agent({ apiKey: 'sk-test', memoryDir: '.custom/memory' });
    assert.ok(agent._memoryDir.endsWith('.custom/memory'));
  });

  it('default _memoryDir is resolved .openrouter/memory when neither option is provided', () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    assert.strictEqual(agent._memoryDir, path.resolve('.openrouter/memory'));
  });

  it('storagePaths.tmpDir generates _todoFile with todos-XXXXX.json pattern', () => {
    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir: '/tmp/lumen-test' } });
    assert.ok(agent._todoFile.startsWith('/tmp/lumen-test'));
    assert.match(path.basename(agent._todoFile), /^todos-[a-z0-9]{5}\.json$/);
  });

  it('two agents with same tmpDir get different _todoFile names', () => {
    const a = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir: '/tmp/lumen-test' } });
    const b = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir: '/tmp/lumen-test' } });
    assert.notStrictEqual(a._todoFile, b._todoFile);
  });

  it('without tmpDir, _todoFile defaults to .todos.json in process.cwd()', () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    assert.strictEqual(agent._todoFile, path.join(process.cwd(), '.todos.json'));
  });

  it('trustedPaths contains external memoryDir', () => {
    const externalDir = path.join(os.tmpdir(), 'lumen-memory');
    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { memoryDir: externalDir } });
    assert.ok(agent.trustedPaths.has(externalDir));
  });

  it('trustedPaths contains external tmpDir', () => {
    const externalTmp = path.join(os.tmpdir(), 'lumen-tmp');
    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir: externalTmp } });
    assert.ok(agent.trustedPaths.has(externalTmp));
  });

  it('trustedPaths is empty when all paths are within project root', () => {
    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { memoryDir: '.openrouter/memory' } });
    assert.strictEqual(agent.trustedPaths.size, 0);
  });
});

describe('Agent — cleanup()', () => {
  let Agent;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
  });

  it('is a no-op when _storageTmpDir is not configured', async () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    await assert.doesNotReject(() => agent.cleanup());
  });

  it('deletes files in _storageTmpDir', async () => {
    const fsP = await import('node:fs/promises');
    const tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'sdk-cleanup-test-'));
    await fsP.writeFile(path.join(tmpDir, 'todos-abc12.json'), '[]');
    await fsP.writeFile(path.join(tmpDir, 'todos-xyz89.json'), '[]');

    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir } });
    await agent.cleanup();

    const entries = await fsP.readdir(tmpDir);
    assert.strictEqual(entries.length, 0);
    await fsP.rm(tmpDir, { recursive: true });
  });

  it('does not remove the tmpDir itself', async () => {
    const fsP = await import('node:fs/promises');
    const tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'sdk-cleanup-test-'));

    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir } });
    await agent.cleanup();

    const stat = await fsP.stat(tmpDir);
    assert.ok(stat.isDirectory());
    await fsP.rm(tmpDir, { recursive: true });
  });

  it('skips subdirectories in tmpDir', async () => {
    const fsP = await import('node:fs/promises');
    const tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'sdk-cleanup-test-'));
    await fsP.mkdir(path.join(tmpDir, 'subdir'));

    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir } });
    await agent.cleanup();

    const entries = await fsP.readdir(tmpDir);
    assert.deepStrictEqual(entries, ['subdir']);
    await fsP.rm(tmpDir, { recursive: true });
  });

  it('is a no-op when tmpDir does not exist yet', async () => {
    const tmpDir = path.join(os.tmpdir(), `sdk-nonexistent-${Date.now()}`);
    const agent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir } });
    await assert.doesNotReject(() => agent.cleanup());
  });
});

describe('run() — steering / pending requests', () => {
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

  it('steer() returns false when the agent is idle', () => {
    const agent = new Agent({ apiKey: 'sk-test' });
    assert.strictEqual(agent.steer('hello'), false);
    assert.strictEqual(agent.isRunning, false);
  });

  it('isRunning is true during an active run and steer() is accepted', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) {
        return makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                reasoning: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Probe', arguments: '{}' } }],
              },
            },
          ],
          usage: { cost: 0, total_tokens: 1 },
        });
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'done', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 1 },
      });
    };
    const agent = new Agent({ apiKey: 'sk-test' });
    let observedRunning;
    let observedSteer;
    agent.use({
      name: 'Probe',
      description: 'probe',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        observedRunning = agent.isRunning;
        observedSteer = agent.steer('mid-flight instruction');
        return 'ok';
      },
    });
    await agent.run('start');
    assert.strictEqual(observedRunning, true);
    assert.strictEqual(observedSteer, true);
    assert.strictEqual(agent.isRunning, false);
  });

  it('concurrent run() enqueues instead of starting a second loop and returns the in-flight promise', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) {
        return makeJsonResponse({
          choices: [
            {
              message: {
                content: null,
                reasoning: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Probe', arguments: '{}' } }],
              },
            },
          ],
          usage: { cost: 0, total_tokens: 1 },
        });
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'final', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 1 },
      });
    };
    const agent = new Agent({ apiKey: 'sk-test' });
    let concurrent;
    agent.use({
      name: 'Probe',
      description: 'probe',
      input_schema: { type: 'object', properties: {}, required: [] },
      execute: async () => {
        concurrent = agent.run('concurrent prompt');
        return 'ok';
      },
    });
    const result = await agent.run('start');
    assert.strictEqual(calls, 2);
    assert.strictEqual(await concurrent, result);
    const userText = JSON.stringify(agent.messages.filter((m) => m.role === 'user'));
    assert.ok(userText.includes('concurrent prompt'));
  });
});
