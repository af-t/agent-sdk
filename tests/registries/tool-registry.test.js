import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../src/registries/tool-registry.js';

const echoTool = {
  name: 'echoText',
  description: 'Return the supplied text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  execute: async ({ text }) => text,
};
const unsupportedInputSchemaKey = ['input', 'schema'].join('_');
const unsupportedOutputLimitKey = ['output', 'limit'].join('_');

test('registers canonical tools and validates their inputs', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);

  assert.deepEqual(registry.listTools(), [
    { name: echoTool.name, description: echoTool.description, inputSchema: echoTool.inputSchema },
  ]);
  await assert.rejects(() => registry.execute('echoText', { text: 4 }), /Parameter "text" must be a string/);
});

test('rejects unsupported snake-case tool keys', async () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.register({ ...echoTool, [unsupportedInputSchemaKey]: echoTool.inputSchema }),
    new RegExp(`Unsupported key: ${unsupportedInputSchemaKey}`),
  );
  assert.throws(
    () => registry.register({ ...echoTool, [unsupportedOutputLimitKey]: 12 }),
    new RegExp(`Unsupported key: ${unsupportedOutputLimitKey}`),
  );
  await assert.rejects(
    () => registry.execute('missing', { [unsupportedOutputLimitKey]: 12 }),
    /Tool "missing" is not registered/,
  );
});

test('passes the logger and signal while stripping outputLimit', async () => {
  const calls = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: (bindings) => ({
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
      bindings,
    }),
  };
  const registry = new ToolRegistry({ logger });
  registry.register({
    ...echoTool,
    execute: async (input, context) => {
      calls.push({ input, context });
      return 'x'.repeat(20);
    },
  });
  const controller = new AbortController();

  assert.match(
    await registry.execute('echoText', { text: 'ok', outputLimit: 5 }, { signal: controller.signal }),
    /truncated/,
  );
  assert.deepEqual(calls[0].input, { text: 'ok' });
  assert.equal(calls[0].context.signal, controller.signal);
  assert.ok(calls[0].context.logger);
});

test('clone inherits existing hooks without sharing later hooks', async () => {
  const registry = new ToolRegistry();
  const calls = [];
  registry.register({
    name: 'probe',
    description: 'Return a marker.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'tool',
  });
  registry.onBeforeExecute(() => {
    calls.push('parent-hook');
  });
  const clone = registry.clone();
  clone.onBeforeExecute(() => ({ override: 'child override' }));

  assert.equal(await clone.execute('probe'), 'child override');
  assert.deepEqual(calls, ['parent-hook']);
  assert.equal(await registry.execute('probe'), 'tool');
  assert.deepEqual(calls, ['parent-hook', 'parent-hook']);
});

test('cloning derives child loggers from the original logger, not from each clone', () => {
  const derivedFrom = [];
  const makeLogger = (depth) => ({
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      derivedFrom.push(depth);
      return makeLogger(depth + 1);
    },
  });

  const registry = new ToolRegistry({ logger: makeLogger(0) });
  registry.clone().clone();

  assert.deepEqual(derivedFrom, [0, 0, 0]);
});

test('maps MCP schemas and closes only owned clients', async () => {
  const client = {
    async connectAndGetTools() {
      return [{ name: 'echo', description: 'Echo', inputSchema: echoTool.inputSchema }];
    },
    async executeTool(_name, input) {
      return { content: [{ type: 'text', text: input.text }] };
    },
    async close() {
      this.closed = true;
    },
  };
  let loggerClosed = false;
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return this;
    },
    close() {
      loggerClosed = true;
    },
  };
  const registry = new ToolRegistry({ logger, mcpClientFactory: () => client });

  await registry.connectMcpServer({ name: 'remote', command: 'unused' });
  assert.deepEqual(registry.listTools()[0], {
    name: 'remote.echo',
    description: 'Echo',
    inputSchema: echoTool.inputSchema,
  });
  assert.equal(await registry.execute('remote.echo', { text: 'hello' }), 'hello');
  await registry.cleanup();
  assert.equal(client.closed, true);
  assert.equal(loggerClosed, false);
});

test('forwards the execution abort signal to remote MCP tools', async () => {
  let receivedSignal;
  const client = {
    async connectAndGetTools() {
      return [{ name: 'echo', description: 'Echo', inputSchema: echoTool.inputSchema }];
    },
    async executeTool(_name, _input, options) {
      receivedSignal = options.signal;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  };
  const registry = new ToolRegistry({ mcpClientFactory: () => client });
  await registry.connectMcpServer({ name: 'remote', command: 'unused' });
  const controller = new AbortController();
  await registry.execute('remote.echo', { text: 'hello' }, { signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
});
