import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import terminalManager from '../../../src/core/terminal.js';
import * as readTool from '../../../src/tools/terminal/read.js';

describe('TerminalRead', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(readTool.name, 'TerminalRead');
    assert.strictEqual(typeof readTool.description, 'string');
    assert.ok(readTool.input_schema);
  });

  it('should execute successfully and return output', async () => {
    mock.method(terminalManager, 'read', () => ({ text: 'hello world' }));

    const result = await readTool.execute({ id: 'session1' });
    assert.strictEqual(result, 'hello world');
    assert.strictEqual(terminalManager.read.mock.calls.length, 1);
    assert.deepStrictEqual(terminalManager.read.mock.calls[0].arguments, ['session1', false]);
  });

  it('should pass clear flag to terminalManager.read', async () => {
    mock.method(terminalManager, 'read', () => ({ text: 'hello world' }));

    await readTool.execute({ id: 'session1', clear: true });
    assert.deepStrictEqual(terminalManager.read.mock.calls[0].arguments, ['session1', true]);
  });

  it('should return fallback message if text is empty', async () => {
    mock.method(terminalManager, 'read', () => ({ text: '' }));

    const result = await readTool.execute({ id: 'session1' });
    assert.strictEqual(result, '(No new output, maybe you forgot to write \\n after executing command)');
  });

  it('should return fallback message if text is undefined', async () => {
    mock.method(terminalManager, 'read', () => ({}));

    const result = await readTool.execute({ id: 'session1' });
    assert.strictEqual(result, '(No new output, maybe you forgot to write \\n after executing command)');
  });

  it('should handle terminal manager errors', async () => {
    mock.method(terminalManager, 'read', () => { throw new Error('Read failed'); });

    const result = await readTool.execute({ id: 'session1' });
    assert.strictEqual(result, 'ERROR: Read failed');
  });
});
