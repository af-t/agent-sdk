import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../../../src/registries/tool-registry.js';
import { readFile } from '../../../src/tools/files/read-file.js';
import { writeFile } from '../../../src/tools/files/write-file.js';
import { editFile } from '../../../src/tools/files/edit-file.js';
import { findFiles } from '../../../src/tools/files/find-files.js';
import { listFiles } from '../../../src/tools/files/list-files.js';

const fileTools = [readFile, writeFile, editFile, findFiles, listFiles];

describe('file tool contracts', () => {
  it('exports complete, canonical tool definitions', () => {
    assert.deepEqual(
      fileTools.map((tool) => Object.keys(tool).sort()),
      Array.from({ length: 5 }, () => ['description', 'execute', 'inputSchema', 'name']),
    );
    assert.deepEqual(
      fileTools.map((tool) => tool.name),
      ['readFile', 'writeFile', 'editFile', 'findFiles', 'listFiles'],
    );
  });

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
});
