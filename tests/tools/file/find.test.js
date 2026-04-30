import { describe, it, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as FindTool from '../../../src/tools/file/find.js';

describe('FindTool', () => {
  let tmpDir;
  const baseDir = path.join(process.cwd(), 'tests', 'tmp', 'find');

  beforeEach(async () => {
    mock.restoreAll();
    await fs.mkdir(baseDir, { recursive: true });
    tmpDir = await fs.mkdtemp(path.join(baseDir, 'test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  after(async () => {
    try {
      await fs.rm(baseDir, { recursive: true, force: true });
      // Also try to remove the common tests/tmp if it's empty
      await fs.rmdir(path.join(process.cwd(), 'tests', 'tmp'));
    } catch {}
  });

  it('should have correct metadata', () => {
    assert.strictEqual(FindTool.name, 'Find');
    assert.strictEqual(typeof FindTool.description, 'string');
    assert.ok(FindTool.input_schema);
  });

  it('should find files by name', async () => {
    await fs.writeFile(path.join(tmpDir, 'target_file.txt'), 'content');
    await fs.writeFile(path.join(tmpDir, 'other_file.txt'), 'content');
    const res = await FindTool.execute({ path: tmpDir, pattern: 'target_file', mode: 'name' });
    assert.match(res, /target_file\.txt/);
    assert.doesNotMatch(res, /other_file\.txt/);
  });

  it('should find text by content', async () => {
    await fs.writeFile(path.join(tmpDir, 'file1.txt'), 'unique text match');
    await fs.writeFile(path.join(tmpDir, 'file2.txt'), 'other content');
    const res = await FindTool.execute({ path: tmpDir, pattern: 'unique text', mode: 'content' });
    assert.match(res, /file1\.txt:\d+: unique text match/);
    assert.doesNotMatch(res, /file2\.txt/);
  });

  it('should return "No matches found." when nothing matches', async () => {
    const res = await FindTool.execute({ path: tmpDir, pattern: 'nonexistent', mode: 'name' });
    assert.strictEqual(res, 'No matches found.');
  });

  it('should return an error for a missing directory', async () => {
    const res = await FindTool.execute({ path: path.join(tmpDir, 'missing'), pattern: 'test', mode: 'name' });
    assert.match(res, /ERROR:/);
    assert.match(res, /ENOENT/);
  });
});
