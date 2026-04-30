import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as ReadTool from '../../../src/tools/file/read.js';

describe('ReadTool', () => {
  let tmpDir;
  let testFile;

  beforeEach(async () => {
    mock.restoreAll();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-read-test-'));
    testFile = path.join(tmpDir, 'test.txt');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct metadata', () => {
    assert.strictEqual(ReadTool.name, 'Read');
    assert.strictEqual(typeof ReadTool.description, 'string');
    assert.ok(ReadTool.input_schema);
  });

  it('should read the whole file', async () => {
    await fs.writeFile(testFile, 'Line 1\nLine 2\nLine 3');
    const res = await ReadTool.execute({ path: testFile });
    assert.match(res, /Line 1/);
    assert.match(res, /Line 2/);
    assert.match(res, /Line 3/);
  });

  it('should read a paginated file', async () => {
    await fs.writeFile(testFile, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
    const res = await ReadTool.execute({ path: testFile, start_line: 2, end_line: 4 });
    assert.match(res, /Line 2/);
    assert.match(res, /Line 3/);
    assert.match(res, /Line 4/);
    assert.doesNotMatch(res, /Line 1/);
    assert.doesNotMatch(res, /Line 5/);
  });

  it('should truncate if max_lines is exceeded', async () => {
    await fs.writeFile(testFile, '1\n2\n3\n4\n5');
    const res = await ReadTool.execute({ path: testFile, max_lines: 2 });
    assert.match(res, /\[\.\.\. truncated\]/);
    assert.match(res, /1/);
    assert.match(res, /2/);
    assert.doesNotMatch(res, /3/);
  });

  it('should return an error for a missing file', async () => {
    const missingPath = path.join(tmpDir, 'missing.txt');
    const res = await ReadTool.execute({ path: missingPath });
    assert.match(res, /ERROR:/);
    assert.match(res, /No such file or directory/);
  });

  it('should handle invalid line ranges', async () => {
    await fs.writeFile(testFile, 'Line 1\nLine 2');
    const res = await ReadTool.execute({ path: testFile, start_line: 10, end_line: 5 });
    assert.strictEqual(res.trim(), ''); // Or whatever the expected behavior is for invalid range
  });
});
