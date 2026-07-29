import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ToolExecutor } from '../../src/agent/tool-executor.js';
import { resolveLogger } from '../../src/support/logger.js';

function createRecordingLogger() {
  const records = [];
  const target = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    target[level] = (context, message) => records.push({ level, context, message });
  }
  return { logger: resolveLogger(target), records };
}

function createContext(overrides = {}) {
  const events = [];
  return {
    agent: { restricted: true },
    logger: undefined,
    maxToolOutput: 1000,
    signal: undefined,
    multimodalUnsupported: false,
    broadcast: async (event) => events.push(event),
    events,
    ...overrides,
  };
}

describe('ToolExecutor: malformed arguments', () => {
  it('reports malformed tool arguments without executing the tool', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => 'ignored') };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute(
      { id: 'call-1', function: { name: 'readFile', arguments: '{bad json' } },
      context,
    );

    assert.equal(result.role, 'tool');
    assert.match(result.content, /Invalid arguments/);
    assert.equal(result.tool_call_id, 'call-1');
    assert.equal(registry.execute.mock.callCount(), 0);
  });

  it('does not broadcast toolStart or toolEnd for a malformed call', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => 'ignored') };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    await executor.execute({ id: 'call-1', function: { name: 'readFile', arguments: 'nope' } }, context);

    assert.deepEqual(context.events, []);
  });

  it('treats empty, whitespace-only, or missing arguments as an empty object', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async (_name, input) => JSON.stringify(input)) };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    for (const rawArgs of ['', '   ', undefined]) {
      const result = await executor.execute({ id: 'c', function: { name: 'NoArgs', arguments: rawArgs } }, context);
      assert.equal(result.content, '{}');
    }
    assert.equal(registry.execute.mock.callCount(), 3);
  });

  it('reports a tool call with a missing function field instead of throwing', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => 'ignored') };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'call-2' }, context);

    assert.equal(result.role, 'tool');
    assert.match(result.content, /Invalid arguments/);
    assert.equal(result.tool_call_id, 'call-2');
    assert.equal(registry.execute.mock.callCount(), 0);
    assert.deepEqual(context.events, []);
  });

  it('still returns a tool_call_id even when the whole call is not an object', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => 'ignored') };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute(undefined, context);

    assert.equal(result.role, 'tool');
    assert.match(result.content, /Invalid arguments/);
    assert.equal(result.tool_call_id, undefined);
  });
});

describe('ToolExecutor: successful execution', () => {
  it('parses JSON arguments and forwards them to the registry', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async (name, input) => `${name}:${JSON.stringify(input)}`) };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'c1', function: { name: 'Echo', arguments: '{"x":1}' } }, context);

    assert.equal(registry.execute.mock.callCount(), 1);
    assert.deepEqual(registry.execute.mock.calls[0].arguments[1], { x: 1 });
    assert.equal(result.content, 'Echo:{"x":1}');
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, 'c1');
  });

  it('forwards agent, logger, maxToolOutput, signal, and tool_call_id to the registry', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => 'ok') };
    const executor = new ToolExecutor({ registry, logger });
    const agent = { marker: true };
    const toolLogger = { marker: 'tool-logger' };
    const controller = new AbortController();
    const context = createContext({ agent, logger: toolLogger, maxToolOutput: 42, signal: controller.signal });

    await executor.execute({ id: 'c1', function: { name: 'Echo', arguments: '{}' } }, context);

    const call = registry.execute.mock.calls[0];
    assert.equal(call.arguments[0], 'Echo');
    assert.equal(call.arguments[2].agent, agent);
    assert.equal(call.arguments[2].logger, toolLogger);
    assert.equal(call.arguments[2].maxToolOutput, 42);
    assert.equal(call.arguments[2].signal, controller.signal);
    assert.equal(call.arguments[2].tool_call_id, 'c1');
  });

  it('broadcasts toolStart before execution and toolEnd with the output after', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => 'done') };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    await executor.execute({ id: 'c1', function: { name: 'Echo', arguments: '{"a":1}' } }, context);

    assert.equal(context.events.length, 2);
    assert.deepEqual(context.events[0], { toolStart: { toolCallId: 'c1', name: 'Echo', input: { a: 1 } } });
    assert.equal(context.events[1].toolEnd.toolCallId, 'c1');
    assert.equal(context.events[1].toolEnd.output, 'done');
    assert.equal(typeof context.events[1].toolEnd.durationMs, 'number');
  });

  it('measures a non-negative durationMs for a successful call', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => new Promise((resolve) => setTimeout(() => resolve('ok'), 5))) };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'c1', function: { name: 'Slow', arguments: '{}' } }, context);

    assert.equal(typeof result.durationMs, 'number');
    assert.ok(result.durationMs >= 0);
  });

  it('runs two calls concurrently rather than one after another', async () => {
    const { logger } = createRecordingLogger();
    let active = 0;
    let maxActive = 0;
    const registry = {
      execute: mock.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return 'ok';
      }),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    await Promise.all([
      executor.execute({ id: 'a', function: { name: 'Slow', arguments: '{}' } }, context),
      executor.execute({ id: 'b', function: { name: 'Slow', arguments: '{}' } }, context),
    ]);

    assert.equal(maxActive, 2, `expected both calls in flight together, saw ${maxActive}`);
  });
});

describe('ToolExecutor: execution failure', () => {
  it('reports a thrown tool error as a tool message instead of throwing', async () => {
    const { logger } = createRecordingLogger();
    const registry = {
      execute: mock.fn(async () => {
        throw new Error('kaboom');
      }),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'c1', function: { name: 'Broken', arguments: '{}' } }, context);

    assert.equal(result.role, 'tool');
    assert.match(result.content, /Error: kaboom/);
    assert.equal(typeof result.durationMs, 'number');
    assert.deepEqual(result.richParts, []);
  });

  it('still broadcasts toolStart and a toolEnd carrying the error', async () => {
    const { logger } = createRecordingLogger();
    const registry = {
      execute: mock.fn(async () => {
        throw new Error('kaboom');
      }),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    await executor.execute({ id: 'c1', function: { name: 'Broken', arguments: '{}' } }, context);

    assert.equal(context.events.length, 2);
    assert.ok(context.events[0].toolStart);
    assert.equal(context.events[1].toolEnd.error, 'kaboom');
  });

  it('forwards an abort signal so a tool can observe cancellation itself', async () => {
    const { logger } = createRecordingLogger();
    const controller = new AbortController();
    const registry = {
      execute: mock.fn(async (_name, _input, ctx) => {
        controller.abort();
        if (ctx.signal.aborted) throw new Error('aborted mid-flight');
        return 'unreachable';
      }),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext({ signal: controller.signal });

    const result = await executor.execute({ id: 'c1', function: { name: 'Cancelable', arguments: '{}' } }, context);

    assert.match(result.content, /aborted mid-flight/);
  });
});

describe('ToolExecutor: multimodal results', () => {
  it('extracts non-text parts from an array result as richParts', async () => {
    const { logger } = createRecordingLogger();
    const registry = {
      execute: mock.fn(async () => [
        { type: 'text', text: 'here is the file' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'c1', function: { name: 'ReadImage', arguments: '{}' } }, context);

    assert.equal(result.content, 'here is the file');
    assert.equal(result.richParts.length, 1);
    assert.equal(result.richParts[0].type, 'image_url');
  });

  it('extracts a single rich object result as one richPart', async () => {
    const { logger } = createRecordingLogger();
    const registry = {
      execute: mock.fn(async () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'c1', function: { name: 'ReadImage', arguments: '{}' } }, context);

    assert.match(result.content, /multimodal content/);
    assert.equal(result.richParts.length, 1);
  });

  it('replaces rich content with a text notice once the model is marked multimodal-unsupported', async () => {
    const { logger } = createRecordingLogger();
    const registry = {
      execute: mock.fn(async () => [
        { type: 'text', text: '' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ]),
    };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext({ multimodalUnsupported: true });

    const result = await executor.execute({ id: 'c1', function: { name: 'ReadImage', arguments: '{}' } }, context);

    assert.equal(result.richParts.length, 0);
    assert.match(result.content, /does not support it/);
  });

  it('leaves a text-only array result untouched', async () => {
    const { logger } = createRecordingLogger();
    const registry = { execute: mock.fn(async () => ['line one', 'line two']) };
    const executor = new ToolExecutor({ registry, logger });
    const context = createContext();

    const result = await executor.execute({ id: 'c1', function: { name: 'Lines', arguments: '{}' } }, context);

    assert.equal(result.content, 'line one\nline two');
    assert.deepEqual(result.richParts, []);
  });
});
