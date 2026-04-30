import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import terminalManager from '../../../src/core/terminal.js';
import * as destroyTool from '../../../src/tools/terminal/destroy.js';

describe('TerminalDestroy', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(destroyTool.name, 'TerminalDestroy');
    assert.strictEqual(typeof destroyTool.description, 'string');
    assert.ok(destroyTool.input_schema);
  });

  it('should execute successfully and destroy session', async () => {
    mock.method(terminalManager, 'destroy', () => {});

    const result = await destroyTool.execute({ id: 'session1' });
    assert.strictEqual(result, 'Session session1 destroyed');
    assert.strictEqual(terminalManager.destroy.mock.calls.length, 1);
    assert.deepStrictEqual(terminalManager.destroy.mock.calls[0].arguments, ['session1']);
  });

  it('should handle terminal manager errors', async () => {
    mock.method(terminalManager, 'destroy', () => { throw new Error('Destroy failed'); });

    const result = await destroyTool.execute({ id: 'session1' });
    assert.strictEqual(result, 'ERROR: Destroy failed');
  });
});
