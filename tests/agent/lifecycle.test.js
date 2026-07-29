import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Lifecycle } from '../../src/agent/lifecycle.js';
import { ConfigError } from '../../src/support/errors.js';
import { resolveLogger } from '../../src/support/logger.js';

function createRecordingLogger() {
  const records = [];
  const target = {};
  for (const level of ['debug', 'info', 'warn', 'error']) {
    target[level] = (context, message) => records.push({ level, context, message });
  }
  return { logger: resolveLogger(target), records };
}

describe('Lifecycle: injectors', () => {
  it('runs injectors in registration order', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({ name: 'first', scope: 'per-turn', run: async () => 'a' });
    lifecycle.registerInjector({ name: 'second', scope: 'per-turn', run: async () => 'b' });
    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), ['a', 'b']);
  });

  it('only runs injectors registered for the requested scope', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({ name: 'first-turn-only', scope: 'first-turn', run: () => 'FIRST' });
    lifecycle.registerInjector({ name: 'per-turn-only', scope: 'per-turn', run: () => 'PER' });
    assert.deepEqual(await lifecycle.applyInjectors('first-turn', {}), ['FIRST']);
    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), ['PER']);
  });

  it('drops empty and whitespace-only injector results', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({ name: 'blank', scope: 'per-turn', run: () => '' });
    lifecycle.registerInjector({ name: 'spaces', scope: 'per-turn', run: () => '   \n  ' });
    lifecycle.registerInjector({ name: 'real', scope: 'per-turn', run: () => 'content' });
    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), ['content']);
  });

  it('passes the given context through to each injector', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    let seen;
    lifecycle.registerInjector({ name: 'demo', scope: 'per-turn', run: (ctx) => (seen = ctx) && 'ok' });
    const context = { messages: [], usage: {}, turn: 3 };
    await lifecycle.applyInjectors('per-turn', context);
    assert.equal(seen, context);
  });

  it('isolates a throwing injector: later injectors still run and their output is kept', async () => {
    const { logger, records } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({
      name: 'broken',
      scope: 'per-turn',
      run: () => {
        throw new Error('boom');
      },
    });
    lifecycle.registerInjector({ name: 'fine', scope: 'per-turn', run: () => 'ok' });

    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), ['ok']);
    assert.ok(records.some((r) => r.level === 'warn' && r.message === 'Agent injector failed'));
  });

  it('rejects an invalid scope', () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    assert.throws(
      () => lifecycle.registerInjector({ name: 'demo', scope: 'nope', run: () => 'x' }),
      (err) => err instanceof ConfigError && /scope must be one of/i.test(err.message),
    );
  });

  it('rejects a run that is not a function', () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    assert.throws(
      () => lifecycle.registerInjector({ name: 'demo', scope: 'per-turn', run: 'not a fn' }),
      (err) => err instanceof ConfigError,
    );
  });

  it('rejects a duplicate name within the same scope', () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({ name: 'dup', scope: 'per-turn', run: () => 'a' });
    assert.throws(
      () => lifecycle.registerInjector({ name: 'dup', scope: 'per-turn', run: () => 'b' }),
      (err) => err instanceof ConfigError && /already registered/i.test(err.message),
    );
  });

  it('allows the same name across different scopes', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({ name: 'shared', scope: 'per-turn', run: () => 'p' });
    lifecycle.registerInjector({ name: 'shared', scope: 'first-turn', run: () => 'f' });
    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), ['p']);
    assert.deepEqual(await lifecycle.applyInjectors('first-turn', {}), ['f']);
  });

  it('the disposer returned by registerInjector removes only that registration', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const dispose = lifecycle.registerInjector({ name: 'temp', scope: 'per-turn', run: () => 'TEMP' });
    lifecycle.registerInjector({ name: 'keep', scope: 'per-turn', run: () => 'KEEP' });
    dispose();
    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), ['KEEP']);
    // Disposal leaves the injector name available.
    lifecycle.registerInjector({ name: 'temp', scope: 'per-turn', run: () => 'TEMP again' });
  });

  it('unregisterInjector removes a registration by name', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.registerInjector({ name: 'demo', scope: 'per-turn', run: () => 'x' });
    lifecycle.unregisterInjector('demo');
    assert.deepEqual(await lifecycle.applyInjectors('per-turn', {}), []);
  });

  it('unregisterInjector is a no-op for an unknown name', () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.unregisterInjector('missing');
  });
});

describe('Lifecycle: before-request hooks', () => {
  it('runs handlers in registration order against a shared payload', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const order = [];
    lifecycle.onBeforeRequest((payload) => {
      order.push('first');
      payload.tag_a = true;
    });
    lifecycle.onBeforeRequest((payload) => {
      order.push('second');
      payload.tag_b = true;
    });

    const payload = {};
    await lifecycle.runBeforeRequest(payload);

    assert.deepEqual(order, ['first', 'second']);
    assert.equal(payload.tag_a, true);
    assert.equal(payload.tag_b, true);
  });

  it('the disposer returned by onBeforeRequest removes the handler', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const dispose = lifecycle.onBeforeRequest((payload) => {
      payload.tag = true;
    });
    dispose();
    const payload = {};
    await lifecycle.runBeforeRequest(payload);
    assert.equal(payload.tag, undefined);
  });

  it('a throwing handler propagates to the caller', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.onBeforeRequest(() => {
      throw new Error('hook failure');
    });
    await assert.rejects(() => lifecycle.runBeforeRequest({}), /hook failure/);
  });
});

describe('Lifecycle: resolveStop', () => {
  function baseArgs(overrides = {}) {
    return {
      payload: { messages: [] },
      isStreaming: false,
      signal: undefined,
      turn: 1,
      content: null,
      reasoning: 'thinking',
      reasoning_details: undefined,
      finish_reason: 'stop',
      usage: {},
      messages: [],
      sendModelRequest: async () => ({ message: { content: 'recovered' }, finishReason: 'stop' }),
      ...overrides,
    };
  }

  it('allows the stop when no hooks are registered', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const result = await lifecycle.resolveStop(baseArgs());
    assert.equal(result.continue, undefined);
    assert.equal(result.content, null);
  });

  it('a continue decision returns a prompt without sending a request', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    let sent = 0;
    lifecycle.onStop(() => ({ action: 'continue', prompt: 'NUDGE' }));
    const result = await lifecycle.resolveStop(
      baseArgs({
        sendModelRequest: async () => {
          sent++;
          return { message: {}, finishReason: 'stop' };
        },
      }),
    );
    assert.deepEqual(result, { continue: true, prompt: 'NUDGE' });
    assert.equal(sent, 0);
  });

  it('a retry decision re-sends the payload and adopts a recovered tool call', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.onStop(() => ({ action: 'retry' }));
    const result = await lifecycle.resolveStop(
      baseArgs({
        sendModelRequest: async () => ({
          message: { tool_calls: [{ id: 'c1' }] },
          finishReason: 'tool_calls',
        }),
      }),
    );
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.finish_reason, 'tool_calls');
  });

  it('user hooks run before the recovery hook; the first non-stop decision wins', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const calls = [];
    lifecycle.onStop(() => {
      calls.push('user');
      return { action: 'continue', prompt: 'USER-NUDGE' };
    });
    const recoveryHook = () => {
      calls.push('recovery');
      return { action: 'continue', prompt: 'RECOVERY-NUDGE' };
    };
    const result = await lifecycle.resolveStop(baseArgs({ recoveryHook }));
    assert.deepEqual(calls, ['user']);
    assert.equal(result.prompt, 'USER-NUDGE');
  });

  it('falls through to the recovery hook when user hooks allow the stop', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.onStop(() => undefined);
    const recoveryHook = () => ({ action: 'continue', prompt: 'RECOVERY-NUDGE' });
    const result = await lifecycle.resolveStop(baseArgs({ recoveryHook }));
    assert.equal(result.prompt, 'RECOVERY-NUDGE');
  });

  it('isolates a throwing stop hook: later hooks still run', async () => {
    const { logger, records } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    lifecycle.onStop(() => {
      throw new Error('boom');
    });
    lifecycle.onStop(() => ({ action: 'continue', prompt: 'AFTER-THROW' }));
    const result = await lifecycle.resolveStop(baseArgs());
    assert.equal(result.prompt, 'AFTER-THROW');
    assert.ok(records.some((r) => r.level === 'warn' && r.message === 'Stop hook failed'));
  });

  it('is bounded by the recovery ceiling when a hook always retries', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    let sent = 0;
    lifecycle.onStop(() => ({ action: 'retry' }));
    const result = await lifecycle.resolveStop(
      baseArgs({
        sendModelRequest: async () => {
          sent++;
          return { message: {}, finishReason: 'stop' };
        },
      }),
    );
    assert.equal(result.continue, undefined);
    assert.ok(sent >= 2 && sent <= 10, `expected the retry loop to be bounded, got ${sent} sends`);
  });

  it('stops issuing retries once the signal is already aborted', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const controller = new AbortController();
    controller.abort();
    lifecycle.onStop(() => ({ action: 'retry' }));
    const result = await lifecycle.resolveStop(baseArgs({ signal: controller.signal }));
    assert.equal(result.continue, undefined);
    assert.equal(result.content, null);
  });

  it('a failed raw retry is surfaced to hooks as lastError', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    const seenLastError = [];
    lifecycle.onStop(({ lastError, attempt }) => {
      seenLastError.push(lastError?.message);
      return attempt === 0 ? { action: 'retry' } : { action: 'continue', prompt: 'AFTER-ERROR' };
    });
    const result = await lifecycle.resolveStop(
      baseArgs({
        sendModelRequest: async () => {
          throw new Error('history schema error');
        },
      }),
    );
    assert.deepEqual(seenLastError, [undefined, 'history schema error']);
    assert.equal(result.prompt, 'AFTER-ERROR');
  });

  it('resetStopAttempts restarts the attempt counter for the next call', async () => {
    const { logger } = createRecordingLogger();
    const lifecycle = new Lifecycle({ logger });
    // A continue decision leaves the attempt counter above zero. Unlike a
    // stop or a recovered retry, resolveStop does not reset it on that path.
    const disposeNudge = lifecycle.onStop(() => ({ action: 'continue', prompt: 'NUDGE' }));
    const first = await lifecycle.resolveStop(baseArgs());
    assert.equal(first.continue, true);
    disposeNudge();

    lifecycle.resetStopAttempts();

    let seenAttempt;
    lifecycle.onStop(({ attempt }) => {
      seenAttempt = attempt;
      return undefined;
    });
    await lifecycle.resolveStop(baseArgs());
    assert.equal(seenAttempt, 0, 'attempt counter restarted at 0 after reset');
  });
});
