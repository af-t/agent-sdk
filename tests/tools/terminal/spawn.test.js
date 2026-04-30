import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert';
import terminalManager from '../../../src/core/terminal.js';
import * as spawnTool from '../../../src/tools/terminal/spawn.js';
import crypto from 'node:crypto';

describe('TerminalSpawn', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(spawnTool.name, 'TerminalSpawn');
    assert.strictEqual(typeof spawnTool.description, 'string');
    assert.ok(spawnTool.input_schema);
  });

  it('should execute successfully and spawn session', async () => {
    mock.method(terminalManager, 'spawn', () => {});
    // Mocking crypto.randomBytes
    mock.method(crypto, 'randomBytes', () => Buffer.from('abcd', 'hex'));

    const result = await spawnTool.execute({ shell: 'bash', cwd: '/tmp', cols: 100, rows: 40 });

    assert.strictEqual(result, 'Session started with ID: term_abcd');
    assert.strictEqual(terminalManager.spawn.mock.calls.length, 1);
    assert.deepStrictEqual(terminalManager.spawn.mock.calls[0].arguments, [
      'term_abcd',
      { shell: 'bash', cwd: '/tmp', cols: 100, rows: 40 }
    ]);
  });

  it('should execute successfully with default options', async () => {
    mock.method(terminalManager, 'spawn', () => {});
    mock.method(crypto, 'randomBytes', () => Buffer.from('1234', 'hex'));

    const result = await spawnTool.execute({});

    assert.strictEqual(result, 'Session started with ID: term_1234');
    assert.strictEqual(terminalManager.spawn.mock.calls.length, 1);
    assert.deepStrictEqual(terminalManager.spawn.mock.calls[0].arguments, [
      'term_1234',
      { shell: undefined, cwd: undefined, cols: undefined, rows: undefined }
    ]);
  });

  it('should handle errors during spawn', async () => {
    mock.method(terminalManager, 'spawn', () => { throw new Error('Spawn failed'); });

    const result = await spawnTool.execute({ shell: 'bash' });
    assert.strictEqual(result, 'Failed to spawn session: Spawn failed');
  });
});
