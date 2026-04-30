import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import terminalManager from '../../../src/core/terminal.js';
import * as waitTool from '../../../src/tools/terminal/wait.js';

describe('TerminalWait', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(waitTool.name, 'TerminalWait');
    assert.strictEqual(typeof waitTool.description, 'string');
    assert.ok(waitTool.input_schema);
  });

  it('should execute successfully', async () => {
    mock.method(terminalManager, 'addObserver', () => {});

    const result = await waitTool.execute({ id: 'session1', pattern: 'done', idleTimeout: 100 });
    assert.strictEqual(result, 'Observer registered. I will notify you when the event occurs.');
    assert.strictEqual(terminalManager.addObserver.mock.calls.length, 1);
    assert.deepStrictEqual(terminalManager.addObserver.mock.calls[0].arguments, ['session1', { pattern: 'done', idleTimeout: 100 }]);
  });

  it('should use default idleTimeout of 300', async () => {
    mock.method(terminalManager, 'addObserver', () => {});

    const result = await waitTool.execute({ id: 'session1', pattern: 'done' });
    assert.strictEqual(result, 'Observer registered. I will notify you when the event occurs.');
    assert.deepStrictEqual(terminalManager.addObserver.mock.calls[0].arguments[1].idleTimeout, 300);
  });

  it('should return error message on failure', async () => {
    mock.method(terminalManager, 'addObserver', () => { throw new Error('Session not found'); });

    const result = await waitTool.execute({ id: 'session1', pattern: 'error' });
    assert.strictEqual(result, 'ERROR: Session not found');
  });
});
