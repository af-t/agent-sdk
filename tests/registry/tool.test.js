import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../src/registry/tool.js';

describe('ToolRegistry', () => {
  it('register and getDefinitions', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'test_tool',
      description: 'A test tool',
      input_schema: { type: 'object', properties: { foo: { type: 'string' } } },
      execute: async () => 'result',
    });

    const defs = registry.getDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, 'test_tool');
    assert.equal(defs[0].function.parameters.properties.foo.type, 'string');
  });

  it('listTools returns tools array', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't1',
      description: 'd1',
      input_schema: {},
      execute: async () => 'r1',
    });
    const list = registry.listTools();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 't1');
  });

  it('execute calls the tool function', async () => {
    const registry = new ToolRegistry();
    let called = false;
    registry.register({
      name: 'call_me',
      description: 'd',
      input_schema: {},
      execute: async (input) => {
        called = true;
        assert.deepEqual(input, { x: 1 });
        return 'ok';
      },
    });

    const res = await registry.execute('call_me', { x: 1 }, {});
    assert.equal(called, true);
    assert.equal(res, 'ok');
  });

  it('execute throws for unknown tool', async () => {
    const registry = new ToolRegistry();
    await assert.rejects(() => registry.execute('nope', {}, {}), { message: /not found/ });
  });

  it('unregister removes a tool', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });
    assert.equal(registry.listTools().length, 1);
    const removed = registry.unregister('t');
    assert.equal(removed, true);
    assert.equal(registry.listTools().length, 0);
  });

  it('unregister returns false for nonexistent tool', () => {
    const registry = new ToolRegistry();
    const removed = registry.unregister('ghost');
    assert.equal(removed, false);
  });

  it('clear resets everything', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });
    registry.clear();
    assert.equal(registry.listTools().length, 0);
    assert.equal(registry.getDefinitions().length, 0);
  });

  it('register requires execute function', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () => registry.register({ name: 't', description: 'd', input_schema: {} }),
      /must have an execute function/,
    );
  });

  it('register throws if name is missing', () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ description: 'd', input_schema: {}, execute: async () => {} }), /name/);
  });

  it('register throws if description is missing', () => {
    const registry = new ToolRegistry();
    assert.throws(() => registry.register({ name: 't', input_schema: {}, execute: async () => {} }), /description/);
  });

  it('onBeforeExecute hook runs before tool execution', async () => {
    const registry = new ToolRegistry();
    let hookCalled = false;
    registry.onBeforeExecute(async ({ name, input }) => {
      hookCalled = true;
      assert.equal(name, 'test');
      assert.equal(input.val, 123);
    });

    registry.register({
      name: 'test',
      description: 'd',
      input_schema: {},
      execute: async () => 'result',
    });

    await registry.execute('test', { val: 123 }, {});
    assert.equal(hookCalled, true);
  });

  it('onBeforeExecute can abort by throwing', async () => {
    const registry = new ToolRegistry();
    registry.onBeforeExecute(() => {
      throw new Error('ABORTED');
    });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    await assert.rejects(() => registry.execute('t', {}, {}), { message: 'ABORTED' });
  });

  it('onAfterExecute hook runs after tool execution', async () => {
    const registry = new ToolRegistry();
    let hookResult = null;
    registry.onAfterExecute(async ({ result }) => {
      hookResult = result;
    });

    registry.register({
      name: 't',
      description: 'd',
      input_schema: {},
      execute: async () => 'success',
    });

    await registry.execute('t', {}, {});
    assert.equal(hookResult, 'success');
  });

  it('onBeforeExecute disposer removes the hook', async () => {
    const registry = new ToolRegistry();
    let count = 0;
    const dispose = registry.onBeforeExecute(() => {
      count++;
    });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    await registry.execute('t', {}, {});
    assert.equal(count, 1);

    dispose();
    await registry.execute('t', {}, {});
    assert.equal(count, 1); // No increase
  });

  it('onAfterExecute disposer removes the hook', async () => {
    const registry = new ToolRegistry();
    let count = 0;
    const dispose = registry.onAfterExecute(() => {
      count++;
    });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    await registry.execute('t', {}, {});
    dispose();
    await registry.execute('t', {}, {});
    assert.equal(count, 1);
  });

  it('validate required parameters', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'req',
      description: 'd',
      input_schema: { type: 'object', required: ['p1'], properties: { p1: { type: 'string' } } },
      execute: async () => 'ok',
    });

    await assert.rejects(() => registry.execute('req', {}, {}), { message: /requires parameter 'p1'/ });
  });

  it('validate parameter type: number', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'number' } } },
      execute: async () => 'ok',
    });
    await assert.rejects(() => registry.execute('t', { p: '123' }, {}), { message: /must be a number/ });
    await assert.doesNotReject(() => registry.execute('t', { p: 123 }, {}));
  });

  it('validate parameter type: string', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'string' } } },
      execute: async () => 'ok',
    });
    await assert.rejects(() => registry.execute('t', { p: 123 }, {}), { message: /must be a string/ });
  });

  it('validate parameter type: boolean', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'boolean' } } },
      execute: async () => 'ok',
    });
    await assert.rejects(() => registry.execute('t', { p: 'true' }, {}), { message: /must be a boolean/ });
  });

  it('validate parameter type: array', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'array' } } },
      execute: async () => 'ok',
    });
    await assert.rejects(() => registry.execute('t', { p: {} }, {}), { message: /must be an array/ });
  });

  it('validate parameter type: object', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { type: 'object' } } },
      execute: async () => 'ok',
    });
    await assert.rejects(() => registry.execute('t', { p: [] }, {}), { message: /must be an object/ });
  });

  it('validate parameter enum', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: 'd',
      input_schema: { type: 'object', properties: { p: { enum: ['a', 'b'] } } },
      execute: async () => 'ok',
    });
    await assert.rejects(() => registry.execute('t', { p: 'c' }, {}), { message: /must be one of \[a, b\]/ });
    await assert.doesNotReject(() => registry.execute('t', { p: 'a' }, {}));
  });

  it('concurrency: execute() from 10 concurrent promises returns correct results', async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    registry.register({
      name: 'concurrent',
      description: 'sleep and return',
      input_schema: { type: 'object', properties: { id: { type: 'number' } } },
      execute: async ({ id }) => {
        callCount++;
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 50));
        return `result-${id}`;
      },
    });

    // Fire 10 concurrent calls
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(registry.execute('concurrent', { id: i }, {}));
    }

    const results = await Promise.all(promises);

    // All results should be correct
    for (let i = 0; i < 10; i++) {
      assert.ok(results.includes(`result-${i}`), `Missing result for id ${i}`);
    }
    assert.equal(callCount, 10);

    // Verify tool definitions are still intact (no state corruption)
    const defs = registry.getDefinitions();
    assert.equal(defs.length, 1);
    assert.equal(defs[0].function.name, 'concurrent');
  });

  it('getDefinitions injects output_limit into every tool schema', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'my_tool',
      description: 'd',
      input_schema: { type: 'object', properties: { x: { type: 'string' } } },
      execute: async () => 'ok',
    });
    const [def] = registry.getDefinitions();
    assert.ok(def.function.parameters.properties.output_limit, 'output_limit should be injected');
    assert.strictEqual(def.function.parameters.properties.output_limit.type, 'number');
    assert.ok(def.function.parameters.properties.x);
  });

  it('execute truncates result when it exceeds agent.maxToolOutputChars', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'big',
      description: 'd',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'x'.repeat(200),
    });
    const fakeAgent = { maxToolOutputChars: 50 };
    const result = await registry.execute('big', {}, { agent: fakeAgent });
    assert.strictEqual(result.length < 200, true);
    assert.ok(result.includes('[... truncated:'));
  });

  it('execute respects output_limit from input over agent default', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'sized',
      description: 'd',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'y'.repeat(300),
    });
    const fakeAgent = { maxToolOutputChars: 200 };
    const result = await registry.execute('sized', { output_limit: 100 }, { agent: fakeAgent });
    assert.ok(result.startsWith('y'.repeat(100)));
    assert.ok(result.includes('[... truncated:'));
  });

  it('execute does not pass output_limit to the tool function', async () => {
    const registry = new ToolRegistry();
    let receivedInput;
    registry.register({
      name: 'spy',
      description: 'd',
      input_schema: { type: 'object', properties: {} },
      execute: async (input) => {
        receivedInput = input;
        return 'ok';
      },
    });
    await registry.execute('spy', { output_limit: 100, foo: 'bar' }, {});
    assert.strictEqual(receivedInput.output_limit, undefined);
    assert.strictEqual(receivedInput.foo, 'bar');
  });

  it('execute does not truncate non-string results', async () => {
    const registry = new ToolRegistry();
    const obj = { a: 1, b: 2 };
    registry.register({
      name: 'objt',
      description: 'd',
      input_schema: { type: 'object', properties: {} },
      execute: async () => obj,
    });
    const result = await registry.execute('objt', { output_limit: 1 }, {});
    assert.deepEqual(result, obj);
  });

  it('concurrency: register and execute from interleaved promises has no state corruption', async () => {
    const registry = new ToolRegistry();
    const results = [];

    // Register first tool
    registry.register({
      name: 'tool_a',
      description: 'A',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'a',
    });

    const p1 = registry.execute('tool_a', {}, {}).then((r) => results.push(r));

    // Concurrently register a second tool
    registry.register({
      name: 'tool_b',
      description: 'B',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'b',
    });

    const p2 = registry.execute('tool_b', {}, {}).then((r) => results.push(r));

    await Promise.all([p1, p2]);

    assert.equal(registry.listTools().length, 2);
    assert.deepEqual(results.sort(), ['a', 'b']);
  });

  it('default parallelSafe is false when not specified', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ps_default',
      description: 'd',
      input_schema: {},
      execute: async () => 'ok',
    });
    assert.equal(registry.isParallelSafe('ps_default'), false);
  });

  it('register accepts parallelSafe: true', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'ps_true',
      description: 'd',
      input_schema: {},
      execute: async () => 'ok',
      parallelSafe: true,
    });
    assert.equal(registry.isParallelSafe('ps_true'), true);
  });

  it('register rejects non-boolean parallelSafe with clear error', () => {
    const registry = new ToolRegistry();
    assert.throws(
      () =>
        registry.register({
          name: 'bad',
          description: 'd',
          input_schema: {},
          execute: async () => 'ok',
          parallelSafe: 'yes',
        }),
      /parallelSafe must be boolean/,
    );
  });

  it('isParallelSafe returns false for unknown tool', () => {
    const registry = new ToolRegistry();
    assert.equal(registry.isParallelSafe('ghost'), false);
  });

  it('hook context includes signal field', async () => {
    const registry = new ToolRegistry();
    let beforeCtx, afterCtx;
    registry.onBeforeExecute(({ context }) => {
      beforeCtx = context;
    });
    registry.onAfterExecute(({ context }) => {
      afterCtx = context;
    });
    registry.register({ name: 't', description: 'd', input_schema: {}, execute: async () => 'r' });

    const controller = new AbortController();
    await registry.execute('t', {}, { signal: controller.signal });
    assert.ok(beforeCtx.signal instanceof AbortSignal);
    assert.ok(afterCtx.signal instanceof AbortSignal);
  });

  it('tool execute receives signal from context', async () => {
    const registry = new ToolRegistry();
    let toolSignal;
    registry.register({
      name: 't',
      description: 'd',
      input_schema: {},
      execute: async (_input, ctx) => {
        toolSignal = ctx.signal;
        return 'ok';
      },
    });

    const controller = new AbortController();
    await registry.execute('t', {}, { signal: controller.signal });
    assert.ok(toolSignal instanceof AbortSignal);
  });

  it('loadTools propagates parallelSafe from module exports', async () => {
    const { loadTools } = await import('../../src/core/utils.js');
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-ps-'));
    await fs.writeFile(
      path.join(tmpDir, 'safe.js'),
      `export const name = 'SafeTool';
     export const description = 'd';
     export const input_schema = { type: 'object', properties: {} };
     export const execute = async () => 'ok';
     export const parallelSafe = true;`,
    );
    await fs.writeFile(
      path.join(tmpDir, 'unsafe.js'),
      `export const name = 'UnsafeTool';
     export const description = 'd';
     export const input_schema = { type: 'object', properties: {} };
     export const execute = async () => 'ok';`,
    );

    const registry = new ToolRegistry();
    for await (const tool of loadTools(tmpDir)) {
      registry.register(tool);
    }

    assert.equal(registry.isParallelSafe('SafeTool'), true);
    assert.equal(registry.isParallelSafe('UnsafeTool'), false);

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
