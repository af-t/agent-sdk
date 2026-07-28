import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../../src/registries/tool-registry.js';
import { readFile } from '../../../src/tools/files/read-file.js';
import { writeFile } from '../../../src/tools/files/write-file.js';
import { editFile } from '../../../src/tools/files/edit-file.js';
import { findFiles } from '../../../src/tools/files/find-files.js';
import { listFiles } from '../../../src/tools/files/list-files.js';

const fileTools = [readFile, writeFile, editFile, findFiles, listFiles];

describe('file tool input validation', () => {
  it('rejects snake_case input fields during schema validation', async () => {
    const registry = new ToolRegistry();
    registry.registerMany(fileTools);

    await assert.rejects(
      () => registry.execute('readFile', { path: 'package.json', start_line: 1 }),
      /Unsupported parameter "start_line"/,
    );
    await assert.rejects(
      () => registry.execute('editFile', { path: 'package.json', edits: [{ action: 'replace', old_text: 'a' }] }),
      /Unsupported parameter "old_text"/,
    );
  });

  it('rejects a non-numeric root outputLimit before executing a tool', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Return text.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => 'unreachable',
    });

    await assert.rejects(
      () => registry.execute('echo', { outputLimit: '10' }),
      /Parameter "outputLimit" must be a finite number/,
    );
  });

  it('rejects nested outputLimit in an edit entry', async () => {
    const registry = new ToolRegistry();
    registry.register(editFile);

    await assert.rejects(
      () =>
        registry.execute('editFile', {
          path: 'package.json',
          edits: [{ action: 'replace', oldText: 'agent-sdk', newText: 'agent-sdk', outputLimit: 10 }],
        }),
      /Unsupported parameter "outputLimit"/,
    );
  });

  it('uses a numeric root outputLimit and strips it before execution', async () => {
    const registry = new ToolRegistry();
    let receivedInput;
    registry.register({
      name: 'echo',
      description: 'Return text.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (input) => {
        receivedInput = input;
        return 'abcdefghij';
      },
    });

    const result = await registry.execute('echo', { outputLimit: 4 });
    assert.deepEqual(receivedInput, {});
    assert.match(result, /^abcd/);
    assert.match(result, /truncated/);
  });
});
