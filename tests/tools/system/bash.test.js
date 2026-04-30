import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as BashTool from '../../../src/tools/system/bash.js';

describe('BashTool', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(BashTool.name, 'Bash');
    assert.strictEqual(typeof BashTool.description, 'string');
    assert.ok(BashTool.input_schema);
  });

  it('should execute command successfully', async () => {
    const result = await BashTool.execute({ command: 'echo "hello"' });
    assert.match(result, /^hello/);
  });

  it('should handle failure exit codes', async () => {
    const result = await BashTool.execute({ command: 'exit 1' });
    assert.match(result, /1/);
  });

  it('should execute with custom environment variables', async () => {
    const result = await BashTool.execute({ command: 'echo "$CUSTOM_ENV"', env: { CUSTOM_ENV: 'test' } });
    assert.match(result, /test/);
  });

  it('should handle execution timeouts', async () => {
    const result = await BashTool.execute({ command: 'sleep 1', timeout: 50 });
    assert.match(result, /Execution timed out after 50ms/);
  });
});
