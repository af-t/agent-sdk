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

test('registers canonical tools and validates their inputs', async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool);

  assert.deepEqual(registry.listTools(), [
    { name: echoTool.name, description: echoTool.description, inputSchema: echoTool.inputSchema },
  ]);
  await assert.rejects(() => registry.execute('echoText', { text: 4 }), /Parameter "text" must be a string/);
});

test('rejects legacy snake_case tool keys', () => {
  const registry = new ToolRegistry();
  assert.throws(
    () => registry.register({ ...echoTool, input_schema: echoTool.inputSchema }),
    /input_schema is not supported/,
  );
  assert.throws(() => registry.register({ ...echoTool, output_limit: 12 }), /output_limit is not supported/);
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
