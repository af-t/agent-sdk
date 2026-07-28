import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AbortError, ApiError, ConfigError, SdkError, ToolError } from '../../src/support/errors.js';

describe('SDK errors', () => {
  it('preserves the supplied code and cause on a base error', () => {
    const cause = new Error('socket closed');
    const error = new SdkError('Request failed', { code: 'REQUEST_ERROR', cause });

    assert(error instanceof Error);
    assert.equal(error.name, 'SdkError');
    assert.equal(error.code, 'REQUEST_ERROR');
    assert.equal(error.cause, cause);
  });

  it('attaches API response details to API errors', () => {
    const cause = new Error('socket closed');
    const error = new ApiError('Request failed', {
      status: 503,
      body: { error: 'unavailable' },
      cause,
    });

    assert(error instanceof SdkError);
    assert.equal(error.code, 'API_ERROR');
    assert.equal(error.status, 503);
    assert.deepEqual(error.body, { error: 'unavailable' });
    assert.equal(error.cause, cause);
  });

  it('attaches the tool name to tool errors', () => {
    const error = new ToolError('Execution failed', { toolName: 'Bash' });

    assert(error instanceof SdkError);
    assert.equal(error.code, 'TOOL_ERROR');
    assert.equal(error.toolName, 'Bash');
  });

  it('uses the config error code while preserving its cause', () => {
    const cause = new Error('invalid value');
    const error = new ConfigError('Bad configuration', { cause });

    assert(error instanceof SdkError);
    assert.equal(error.code, 'CONFIG_ERROR');
    assert.equal(error.cause, cause);
  });

  it('uses the abort error code while preserving its cause', () => {
    const cause = new Error('request interrupted');
    const error = new AbortError('Run aborted', { cause });

    assert(error instanceof SdkError);
    assert.equal(error.code, 'ABORT_ERROR');
    assert.equal(error.cause, cause);
  });
});
