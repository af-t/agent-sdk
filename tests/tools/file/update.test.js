import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as UpdateTool from '../../../src/tools/file/update.js';

describe('UpdateTool', () => {
  let tmpDir;
  let testFile;

  beforeEach(async () => {
    mock.restoreAll();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-update-test-'));
    testFile = path.join(tmpDir, 'test.txt');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should have correct metadata', () => {
    assert.strictEqual(UpdateTool.name, 'Edit');
    assert.strictEqual(typeof UpdateTool.description, 'string');
    assert.ok(UpdateTool.input_schema);
  });

  it('should update file with old_text', async () => {
    await fs.writeFile(testFile, 'Hello world!\nThis is a test.');
    const res = await UpdateTool.execute({
      path: testFile,
      old_text: 'world!',
      new_text: 'Gemini!'
    });
    assert.match(res, /updated successfully/);
    const content = await fs.readFile(testFile, 'utf8');
    assert.strictEqual(content, 'Hello Gemini!\nThis is a test.');
  });

  it('should update file with start_line and end_line', async () => {
    await fs.writeFile(testFile, 'Line 1\nLine 2\nLine 3\nLine 4');
    const res = await UpdateTool.execute({
      path: testFile,
      start_line: 2,
      end_line: 3,
      new_text: 'Replaced Lines'
    });
    assert.match(res, /updated successfully/);
    const content = await fs.readFile(testFile, 'utf8');
    assert.strictEqual(content, 'Line 1\nReplaced Lines\nLine 4');
  });

  it('should fail if old_text is not found', async () => {
    await fs.writeFile(testFile, 'Line 1');
    const res = await UpdateTool.execute({
      path: testFile,
      old_text: 'Not found',
      new_text: 'Replacement'
    });
    assert.match(res, /ERROR: 'old_text' not found/);
  });

  it('should fail if old_text is found multiple times', async () => {
    await fs.writeFile(testFile, 'Line 1\nLine 1');
    const res = await UpdateTool.execute({
      path: testFile,
      old_text: 'Line 1',
      new_text: 'Replacement'
    });
    assert.match(res, /ERROR: 'old_text' found multiple times/);
  });

  it('should fail if missing required arguments', async () => {
    await fs.writeFile(testFile, 'Line 1');
    const res = await UpdateTool.execute({
      path: testFile,
      new_text: 'Replacement'
    });
    assert.match(res, /ERROR: Either 'old_text' or both 'start_line' and 'end_line' must be provided/);
  });

  it('should handle edge cases like empty new_text', async () => {
    await fs.writeFile(testFile, 'Line 1\nLine 2');
    const res = await UpdateTool.execute({
      path: testFile,
      old_text: 'Line 2',
      new_text: ''
    });
    assert.match(res, /updated successfully/);
    const content = await fs.readFile(testFile, 'utf8');
    assert.strictEqual(content, 'Line 1\n');
  });
});
