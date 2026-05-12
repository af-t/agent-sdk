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
