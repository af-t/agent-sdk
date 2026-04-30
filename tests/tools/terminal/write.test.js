import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import terminalManager from '../../../src/core/terminal.js';
import * as writeTool from '../../../src/tools/terminal/write.js';

describe('TerminalWrite', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(writeTool.name, 'TerminalWrite');
    assert.strictEqual(typeof writeTool.description, 'string');
    assert.ok(writeTool.input_schema);
  });

  it('should execute successfully and append newline', async () => {
    mock.method(terminalManager, 'write', () => {});

    const result = await writeTool.execute({ id: 'session1', input: 'ls' });
    assert.strictEqual(result, 'Input sent to session session1');
    assert.strictEqual(terminalManager.write.mock.calls.length, 1);
    assert.deepStrictEqual(terminalManager.write.mock.calls[0].arguments, ['session1', 'ls\n']);
  });

  it('should not append newline if already present', async () => {
    mock.method(terminalManager, 'write', () => {});

    await writeTool.execute({ id: 'session1', input: 'ls\n' });
    assert.deepStrictEqual(terminalManager.write.mock.calls[0].arguments, ['session1', 'ls\n']);
  });

  it('should prevent echo to file', async () => {
    const result = await writeTool.execute({ id: 'session1', input: 'echo hello > file.txt' });
    assert.strictEqual(result, 'ERROR: using echo to write files is prohibited');
  });

  it('should prevent cat to file', async () => {
    const result = await writeTool.execute({ id: 'session1', input: 'cat > file.txt << EOF' });
    assert.strictEqual(result, 'ERROR: using cat to write files is prohibited');
  });

  it('should handle terminal manager errors', async () => {
    mock.method(terminalManager, 'write', () => { throw new Error('Write failed'); });

    const result = await writeTool.execute({ id: 'session1', input: 'ls' });
    assert.strictEqual(result, 'ERROR: Write failed');
  });
});
