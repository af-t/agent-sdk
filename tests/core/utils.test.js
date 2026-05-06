import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

describe('ToolRegistry', () => {
  let ToolRegistry;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    ToolRegistry = mod.ToolRegistry;
  });

  it('register and getDefinitions', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test_tool',
      description: 'A test tool',
      input_schema: { type: 'object', properties: { x: { type: 'number' } } },
      execute: async (input) => input.x * 2,
    });
    const defs = registry.getDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, 'test_tool');
    assert.equal(defs[0].function.description, 'A test tool');
  });

  it('listTools returns tools array', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'tool_a',
      description: 'Tool A',
      input_schema: {},
      execute: async () => 'a',
    });
    const tools = registry.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'tool_a');
  });

  it('execute calls the tool function', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'double',
      description: 'Doubles a number',
      input_schema: { type: 'object', properties: { val: { type: 'number' } } },
      execute: async (input) => input.val * 2,
    });
    const result = await registry.execute('double', { val: 5 }, {});
    assert.equal(result, 10);
  });

  it('execute throws for unknown tool', async () => {
    const registry = new ToolRegistry();
    await assert.rejects(
      () => registry.execute('nonexistent', {}, {}),
      { message: /Tool nonexistent not found/ },
    );
  });

  it('unregister removes a tool', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'temp',
      description: 'Temporary',
      input_schema: {},
      execute: async () => {},
    });
    assert.equal(registry.listTools().length, 1);
    const deleted = registry.unregister('temp');
    assert.equal(deleted, true);
    assert.equal(registry.listTools().length, 0);
  });

  it('unregister returns false for nonexistent tool', () => {
    const registry = new ToolRegistry();
    assert.equal(registry.unregister('ghost'), false);
  });

  it('clear resets everything', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't1', description: '', input_schema: {}, execute: async () => {},
    });
    registry.onBeforeExecute(() => {});
    registry.clear();
    assert.equal(registry.listTools().length, 0);
    let called = false;
    registry.onBeforeExecute(() => { called = true; });
    assert.equal(called, false);
  });

  it('register requires execute function', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.register({ name: 'bad', description: '', input_schema: {} }),
      { message: /Tool must have an execute function/ },
    );
  });

  it('onBeforeExecute hook runs before tool execution', async () => {
    const registry = new ToolRegistry();
    const calls = [];
    registry.onBeforeExecute(({ name }) => { calls.push(`before:${name}`); });
    registry.register({
      name: 'hook_test',
      description: '',
      input_schema: {},
      execute: async () => 'done',
    });
    await registry.execute('hook_test', {}, {});
    assert.deepEqual(calls, ['before:hook_test']);
  });

  it('onBeforeExecute can abort by throwing', async () => {
    const registry = new ToolRegistry();
    registry.onBeforeExecute(() => { throw new Error('Aborted!'); });
    registry.register({
      name: 'abort_test',
      description: '',
      input_schema: {},
      execute: async () => 'never runs',
    });
    await assert.rejects(
      () => registry.execute('abort_test', {}, {}),
      { message: 'Aborted!' },
    );
  });

  it('onAfterExecute hook runs after tool execution', async () => {
    const registry = new ToolRegistry();
    const calls = [];
    registry.onAfterExecute(({ name, result }) => { calls.push(`after:${name}=${result}`); });
    registry.register({
      name: 'post',
      description: '',
      input_schema: {},
      execute: async () => 'value',
    });
    await registry.execute('post', {}, {});
    assert.deepEqual(calls, ['after:post=value']);
  });

  it('onBeforeExecute disposer removes the hook', async () => {
    const registry = new ToolRegistry();
    const calls = [];
    const disposer = registry.onBeforeExecute(({ name }) => { calls.push(name); });
    disposer();
    registry.register({
      name: 'no_hook',
      description: '',
      input_schema: {},
      execute: async () => 'ok',
    });
    await registry.execute('no_hook', {}, {});
    assert.deepEqual(calls, []);
  });

  it('onAfterExecute disposer removes the hook', async () => {
    const registry = new ToolRegistry();
    const calls = [];
    const disposer = registry.onAfterExecute(({ name }) => { calls.push(name); });
    disposer();
    registry.register({
      name: 'no_post',
      description: '',
      input_schema: {},
      execute: async () => 'ok',
    });
    await registry.execute('no_post', {}, {});
    assert.deepEqual(calls, []);
  });

  it('validate required parameters', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'greet',
      description: '',
      input_schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      execute: async (input) => `Hello ${input.name}`,
    });
    await assert.rejects(
      () => registry.execute('greet', {}, {}),
      { message: /Tool 'greet' requires parameter 'name'/ },
    );
    await assert.rejects(
      () => registry.execute('greet', { name: null }, {}),
      { message: /requires parameter 'name'/ },
    );
    await assert.rejects(
      () => registry.execute('greet', { name: '' }, {}),
      { message: /requires parameter 'name'/ },
    );
  });

  it('validate parameter type: number', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'num',
      description: '',
      input_schema: {
        type: 'object',
        properties: { x: { type: 'number' } },
      },
      execute: async () => 'ok',
    });
    await assert.rejects(
      () => registry.execute('num', { x: 'not-a-number' }, {}),
      { message: /must be a number/ },
    );
  });

  it('validate parameter type: string', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'str',
      description: '',
      input_schema: {
        type: 'object',
        properties: { s: { type: 'string' } },
      },
      execute: async () => 'ok',
    });
    await assert.rejects(
      () => registry.execute('str', { s: 42 }, {}),
      { message: /must be a string/ },
    );
  });

  it('validate parameter type: boolean', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'bool',
      description: '',
      input_schema: {
        type: 'object',
        properties: { b: { type: 'boolean' } },
      },
      execute: async () => 'ok',
    });
    await assert.rejects(
      () => registry.execute('bool', { b: 'true' }, {}),
      { message: /must be a boolean/ },
    );
  });

  it('validate parameter type: array', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'arr',
      description: '',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'array' } },
      },
      execute: async () => 'ok',
    });
    await assert.rejects(
      () => registry.execute('arr', { a: 'not-array' }, {}),
      { message: /must be an array/ },
    );
  });

  it('validate parameter type: object', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'obj',
      description: '',
      input_schema: {
        type: 'object',
        properties: { o: { type: 'object' } },
      },
      execute: async () => 'ok',
    });
    await assert.rejects(
      () => registry.execute('obj', { o: [] }, {}),
      { message: /must be an object/ },
    );
    await assert.rejects(
      () => registry.execute('obj', { o: 'string' }, {}),
      { message: /must be an object/ },
    );
  });

  it('validate parameter enum', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'enum_tool',
      description: '',
      input_schema: {
        type: 'object',
        properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } },
      },
      execute: async () => 'ok',
    });
    await assert.rejects(
      () => registry.execute('enum_tool', { color: 'yellow' }, {}),
      { message: /must be one of/ },
    );
    const r = await registry.execute('enum_tool', { color: 'red' }, {});
    assert.equal(r, 'ok');
  });
});

describe('ensureSafePath', () => {
  let ensureSafePath;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    ensureSafePath = mod.ensureSafePath;
  });

  it('accepts valid relative path', () => {
    const result = ensureSafePath('src/core/utils.js');
    assert.ok(result);
    assert.ok(result.endsWith('src/core/utils.js'));
  });

  it('accepts valid absolute path within project', () => {
    const result = ensureSafePath(path.resolve(projectRoot, 'src/core/utils.js'));
    assert.ok(result);
  });

  it('rejects null byte in path', () => {
    assert.throws(
      () => ensureSafePath('../../etc/passwd\0'),
      { message: /null byte/ },
    );
  });

  it('rejects path with .. traversal', () => {
    // Note: the code catches bare .. via decoded.includes('..') which throws
    // "URL-encoded traversal characters" — this is the actual behavior.
    assert.throws(
      () => ensureSafePath('../../etc/passwd'),
      { message: /traversal/ },
    );
  });

  it('rejects URL-encoded path traversal %2e%2e', () => {
    assert.throws(
      () => ensureSafePath('%2e%2e/etc/passwd'),
      { message: /URL-encoded traversal/ },
    );
  });

  it('rejects protocol handler file://', () => {
    assert.throws(
      () => ensureSafePath('file:///etc/passwd'),
      { message: /protocol handler/ },
    );
  });

  it('rejects protocol handler https://', () => {
    assert.throws(
      () => ensureSafePath('https://evil.com/payload'),
      { message: /protocol handler/ },
    );
  });
});

describe('withRetry', () => {
  let withRetry;
  let origSetTimeout;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    withRetry = mod.withRetry;
    // Save original setTimeout
    origSetTimeout = global.setTimeout;
  });

  after(() => {
    // Restore setTimeout if we mocked it
    if (global.setTimeout !== origSetTimeout) {
      global.setTimeout = origSetTimeout;
    }
  });

  it('succeeds on first attempt', async () => {
    const result = await withRetry(async () => 'success', 3);
    assert.equal(result, 'success');
  });

  it('succeeds after retries (using fast timers)', async () => {
    // Replace setTimeout with a fast version for delay-sensitive tests
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 3) throw new Error('temporary failure');
        return 'recovered';
      }, 5);
      assert.equal(result, 'recovered');
      assert.equal(attempts, 3);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it('throws if all retries exhausted (using fast timers)', async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      await assert.rejects(
        () => withRetry(async () => { throw new Error('persistent'); }, 2),
        { message: 'persistent' },
      );
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it('circuit breaker: does not retry 4xx client errors', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        const err = new Error('Bad Request');
        err.status = 400;
        throw err;
      }, 5),
      { message: 'Bad Request' },
    );
    assert.equal(attempts, 1);
  });

  it('circuit breaker: does not retry 401', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        const err = new Error('Unauthorized');
        err.status = 401;
        throw err;
      }, 5),
    );
    assert.equal(attempts, 1);
  });

  it('circuit breaker: does not retry 403', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        const err = new Error('Forbidden');
        err.status = 403;
        throw err;
      }, 5),
    );
    assert.equal(attempts, 1);
  });

  it('circuit breaker: does not retry 404', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        const err = new Error('Not Found');
        err.status = 404;
        throw err;
      }, 5),
    );
    assert.equal(attempts, 1);
  });

  it('circuit breaker: does not retry 400 with different message', async () => {
    let attempts = 0;
    await assert.rejects(
      () => withRetry(async () => {
        attempts++;
        const err = new Error('Validation Error');
        err.status = 400;
        throw err;
      }, 3),
    );
    assert.equal(attempts, 1);
  });

  it('calls callback on final failure', async () => {
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      let callbackCalled = false;
      await assert.rejects(
        () => withRetry(
          async () => { throw new Error('fail'); },
          2,
          () => { callbackCalled = true; },
        ),
      );
      assert.equal(callbackCalled, true);
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });
});

describe('getIgnoreFilter', () => {
  let getIgnoreFilter;
  let clearIgnoreFilterCache;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    getIgnoreFilter = mod.getIgnoreFilter;
    clearIgnoreFilterCache = mod.clearIgnoreFilterCache;
  });

  after(() => {
    clearIgnoreFilterCache();
  });

  it('returns a filter object with test, ignores, and add methods', async () => {
    const filter = await getIgnoreFilter();
    assert.equal(typeof filter.test, 'function');
    assert.equal(typeof filter.ignores, 'function');
    assert.equal(typeof filter.add, 'function');
  });

  it('caches the result based on cwd', async () => {
    clearIgnoreFilterCache();
    const f1 = await getIgnoreFilter();
    const f2 = await getIgnoreFilter();
    assert.equal(f1, f2);
  });
});
