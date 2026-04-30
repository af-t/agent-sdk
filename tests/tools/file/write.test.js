import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as WriteTool from '../../../src/tools/file/write.js';

describe('WriteTool', () => {
  let tmpDir;

  beforeEach(async () => {
    mock.restoreAll();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-write-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct metadata', () => {
    assert.strictEqual(WriteTool.name, 'Write');
    assert.strictEqual(typeof WriteTool.description, 'string');
    assert.ok(WriteTool.input_schema);
  });

  it('should write to a new file', async () => {
    const testFile = path.join(tmpDir, 'new_file.txt');
    const res = await WriteTool.execute({
      path: testFile,
      content: 'Hello, World!'
    });
    assert.match(res, /File written to/);
    const content = await fs.readFile(testFile, 'utf8');
    assert.strictEqual(content, 'Hello, World!');
  });

  it('should create missing parent directories', async () => {
    const testFile = path.join(tmpDir, 'deep', 'dir', 'file.txt');
    const res = await WriteTool.execute({
      path: testFile,
      content: 'Deep content'
    });
    assert.match(res, /File written to/);
    const content = await fs.readFile(testFile, 'utf8');
    assert.strictEqual(content, 'Deep content');
  });

  it('should overwrite an existing file', async () => {
    const testFile = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(testFile, 'Old content');
    const res = await WriteTool.execute({
      path: testFile,
      content: 'New content'
    });
    assert.match(res, /File written to/);
    const content = await fs.readFile(testFile, 'utf8');
    assert.strictEqual(content, 'New content');
  });

  it('should return an error on failure (e.g., permission denied)', async () => {
    // Using a path that is likely to fail (root level without permissions)
    const res = await WriteTool.execute({
      path: '/root/file.txt',
      content: 'content'
    });
    assert.match(res, /ERROR:/);
    assert.match(res, /EACCES|ENOENT/);
  });
});
