import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAbortError, retry } from '../../src/support/retry.js';

const FAST_RETRY = { attempts: 5, baseDelayMs: 0, maxDelayMs: 1 };

describe('retry', () => {
  it('does not invoke an operation when its signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await assert.rejects(
      () =>
        retry(
          async () => {
            calls += 1;
            throw new Error('operation should not run');
          },
          { ...FAST_RETRY, signal: controller.signal },
        ),
      (error) => error.aborted === true,
    );
    assert.equal(calls, 0);
  });

  it('returns the first successful result', async () => {
    assert.equal(await retry(async () => 'success', FAST_RETRY), 'success');
  });

  it('retries retryable failures until the operation recovers', async () => {
    let attempts = 0;
    const result = await retry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('temporary');
      return 'recovered';
    }, FAST_RETRY);
    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  });

  it('throws the final error after exhausting attempts', async () => {
    await assert.rejects(
      () =>
        retry(
          async () => {
            throw new Error('persistent');
          },
          { ...FAST_RETRY, attempts: 3 },
        ),
      /persistent/,
    );
  });

  it('does not retry non-retryable HTTP status codes', async () => {
    for (const status of [400, 401, 403, 404, 501]) {
      let attempts = 0;
      await assert.rejects(
        () =>
          retry(async () => {
            attempts += 1;
            throw { status };
          }, FAST_RETRY),
        { status },
      );
      assert.equal(attempts, 1);
    }
  });

  it('does not retry caller abort errors', async () => {
    let attempts = 0;
    const abortError = createAbortError('Stopped');
    await assert.rejects(
      () =>
        retry(async () => {
          attempts += 1;
          throw abortError;
        }, FAST_RETRY),
      /Stopped/,
    );
    assert.equal(attempts, 1);
    assert.equal(abortError.aborted, true);
  });

  it('runs the exhaustion callback after retryable failures', async () => {
    let exhausted = false;
    await assert.rejects(
      () =>
        retry(
          async () => {
            throw new Error('failed');
          },
          {
            ...FAST_RETRY,
            attempts: 2,
            onExhausted: () => {
              exhausted = true;
            },
          },
        ),
      /failed/,
    );
    assert.equal(exhausted, true);
  });

  it('logs exhaustion callback failures structurally', async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    await assert.rejects(
      () =>
        retry(
          async () => {
            throw new Error('failed');
          },
          {
            ...FAST_RETRY,
            attempts: 1,
            logger,
            onExhausted: () => {
              throw new Error('callback failed');
            },
          },
        ),
      /failed/,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0].component, 'retry');
    assert.match(warnings[0][0].error.message, /callback failed/);
    assert.equal(warnings[0][1], 'Retry exhaustion callback failed');
  });

  it('does not wait indefinitely for a hanging exhaustion callback', async () => {
    const original = globalThis.setTimeout;
    globalThis.setTimeout = (callback, _delay, ...args) => original(callback, 1, ...args);
    try {
      await assert.rejects(
        () =>
          retry(
            async () => {
              throw new Error('failed');
            },
            { ...FAST_RETRY, attempts: 1, onExhausted: () => new Promise(() => {}) },
          ),
        /failed/,
      );
    } finally {
      globalThis.setTimeout = original;
    }
  });

  it('varies backoff delays with jitter', async () => {
    const original = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
      delays.push(delay);
      return original(callback, 1, ...args);
    };
    try {
      await assert.rejects(() =>
        retry(
          async () => {
            throw new Error('failed');
          },
          { attempts: 3, baseDelayMs: 100, maxDelayMs: 60_000 },
        ),
      );
      assert.ok(delays.length >= 2);
      assert.ok(new Set(delays.map(Math.round)).size > 1);
    } finally {
      globalThis.setTimeout = original;
    }
  });
});
