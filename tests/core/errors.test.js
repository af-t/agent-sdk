import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ToolError, ConfigError } from '../../src/core/errors.js';

describe('ApiError', () => {
  it('creates an error with message, status, and body', () => {
    const err = new ApiError('Not Found', 404, { error: 'missing' });
    assert(err instanceof Error);
    assert(err instanceof ApiError);
    assert.strictEqual(err.name, 'ApiError');
    assert.strictEqual(err.message, 'Not Found');
    assert.strictEqual(err.status, 404);
    assert.deepEqual(err.body, { error: 'missing' });
  });

  it('handles undefined status and body', () => {
    const err = new ApiError('Server error');
    assert.strictEqual(err.status, undefined);
    assert.strictEqual(err.body, undefined);
  });
});

describe('ToolError', () => {
  it('creates an error with message and toolName', () => {
    const err = new ToolError('Execution failed', 'Bash');
    assert(err instanceof Error);
    assert(err instanceof ToolError);
    assert.strictEqual(err.name, 'ToolError');
    assert.strictEqual(err.message, 'Execution failed');
    assert.strictEqual(err.toolName, 'Bash');
  });

  it('works without toolName', () => {
    const err = new ToolError('Something went wrong');
    assert.strictEqual(err.toolName, undefined);
  });
});

describe('ConfigError', () => {
  it('creates an error with message', () => {
    const err = new ConfigError('Missing API key');
    assert(err instanceof Error);
    assert(err instanceof ConfigError);
    assert.strictEqual(err.name, 'ConfigError');
    assert.strictEqual(err.message, 'Missing API key');
  });
});

describe('throw and catch behavior', () => {
  it('ApiError can be thrown and caught — instanceof checks pass in catch block', () => {
    let caught;
    try {
      throw new ApiError('Unauthorized', 401, { detail: 'bad key' });
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ApiError);
    assert(caught instanceof Error);
    assert.strictEqual(caught.status, 401);
    assert.deepEqual(caught.body, { detail: 'bad key' });
  });

  it('ToolError can be thrown and caught — toolName accessible in catch block', () => {
    let caught;
    try {
      throw new ToolError('execution failed', 'Bash');
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ToolError);
    assert(caught instanceof Error);
    assert.strictEqual(caught.toolName, 'Bash');
  });

  it('ConfigError can be thrown and caught — message accessible in catch block', () => {
    let caught;
    try {
      throw new ConfigError('missing key');
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ConfigError);
    assert(caught instanceof Error);
    assert.strictEqual(caught.message, 'missing key');
  });

  it('error.stack is a non-empty string', () => {
    assert.strictEqual(typeof new ApiError('test').stack, 'string');
    assert.ok(new ApiError('test').stack.length > 0);
  });

  it('ApiError works with Promise.reject().catch()', async () => {
    const caught = await Promise.reject(new ApiError('async', 500, { code: 1 })).catch((e) => e);
    assert(caught instanceof ApiError);
    assert.strictEqual(caught.status, 500);
    assert.deepEqual(caught.body, { code: 1 });
  });

  it('ToolError works with Promise.reject().catch()', async () => {
    const caught = await Promise.reject(new ToolError('tool failed', 'Read')).catch((e) => e);
    assert(caught instanceof ToolError);
    assert.strictEqual(caught.toolName, 'Read');
  });

  it('JSON.stringify does not throw on any error type', () => {
    assert.doesNotThrow(() => JSON.stringify(new ApiError('test', 404, {})));
    assert.doesNotThrow(() => JSON.stringify(new ToolError('test', 'Bash')));
    assert.doesNotThrow(() => JSON.stringify(new ConfigError('test')));
  });

  it('ApiError thrown from async function is catchable with await/try-catch', async () => {
    const fn = async () => {
      throw new ApiError('async error', 503);
    };
    let caught;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ApiError);
    assert.strictEqual(caught.status, 503);
  });

  it('ToolError thrown from async function is catchable with await/try-catch', async () => {
    const fn = async () => {
      throw new ToolError('async tool error', 'Write');
    };
    let caught;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ToolError);
    assert.strictEqual(caught.toolName, 'Write');
  });

  it('ConfigError thrown from async function is catchable with await/try-catch', async () => {
    const fn = async () => {
      throw new ConfigError('async config error');
    };
    let caught;
    try {
      await fn();
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof ConfigError);
    assert.strictEqual(caught.message, 'async config error');
  });
});
