import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures');
const TEST_FILE = path.join(FIXTURES, 'write-test-output.txt');

describe('write.js execute', () => {
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    // Clean up any leftover from previous runs
    await fs.rm(TEST_FILE, { force: true });
  });

  after(async () => {
    await fs.rm(TEST_FILE, { force: true });
  });

  it('creates a new file with content', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const result = await mod.execute({ path: TEST_FILE, content: 'Hello, World!' });
    assert.ok(result.includes('File written'));
    assert.ok(result.includes(TEST_FILE));
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.strictEqual(content, 'Hello, World!');
  });

  it('overwrites an existing file', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    await mod.execute({ path: TEST_FILE, content: 'First write' });
    await mod.execute({ path: TEST_FILE, content: 'Overwritten content' });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.strictEqual(content, 'Overwritten content');
  });

  it('writes empty content', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    await mod.execute({ path: TEST_FILE, content: '' });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.strictEqual(content, '');
  });

  it('rejects oversized content (> 10MB)', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const oversized = 'x'.repeat(11 * 1024 * 1024);
    await assert.rejects(
      () => mod.execute({ path: TEST_FILE, content: oversized }),
      /File too large/
    );
  });

  it('returns metadata about the written file', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const result = await mod.execute({ path: TEST_FILE, content: 'test data' });
    assert.ok(result.includes('Bytes written'));
    assert.ok(result.includes('Absolute path'));
  });
});
