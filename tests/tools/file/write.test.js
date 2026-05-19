import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures');
const TEST_FILE = path.join(FIXTURES, 'write-test-output.txt');
const LARGE_TEST_FILE = path.join(FIXTURES, 'write-large-test.txt');

describe('write.js execute', () => {
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    // Clean up any leftover from previous runs
    await fs.rm(TEST_FILE, { force: true });
    await fs.rm(LARGE_TEST_FILE, { force: true });
  });

  after(async () => {
    await fs.rm(TEST_FILE, { force: true });
    await fs.rm(LARGE_TEST_FILE, { force: true });
  });

  it('creates a new file with content', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const result = await mod.execute({ path: TEST_FILE, content: 'hello world' });
    assert.ok(result.includes('File written'));
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.equal(content, 'hello world');
  });

  it('overwrites an existing file when overwrite=true', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    await fs.writeFile(TEST_FILE, 'old content');
    await mod.execute({ path: TEST_FILE, content: 'new content', overwrite: true });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.equal(content, 'new content');
  });

  it('writes empty content', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    await mod.execute({ path: TEST_FILE, content: '', overwrite: true });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.equal(content, '');
  });

  it('rejects oversized content (> 10MB)', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const largeContent = 'x'.repeat(11 * 1024 * 1024);
    await assert.rejects(() => mod.execute({ path: TEST_FILE, content: largeContent }), /File too large/);
  });

  it('accepts content exactly at 10MB limit', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const size = 10 * 1024 * 1024; // exactly 10MB
    const content = 'y'.repeat(size);
    const result = await mod.execute({ path: LARGE_TEST_FILE, content });
    assert.ok(result.includes('File written'));
    // Verify file was written
    const stat = await fs.stat(LARGE_TEST_FILE);
    assert.equal(stat.size, size);
  });

  it('rejects content just over 10MB limit (10MB + 1 byte)', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const size = 10 * 1024 * 1024 + 1; // 10MB + 1 byte
    const content = 'z'.repeat(size);
    await assert.rejects(() => mod.execute({ path: TEST_FILE, content }), /File too large/);
  });

  it('handles multi-byte UTF-8 characters near the size limit', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    // Use 3-byte UTF-8 characters (e.g., many CJK chars are 3 bytes)
    // Create content that's just under 10MB with multi-byte chars
    const char = '\u4e16'; // 世 — 3 bytes in UTF-8
    const charBytes = Buffer.byteLength(char, 'utf8');
    assert.equal(charBytes, 3, 'Expected 3-byte UTF-8 character');

    // Build a string that approaches but doesn't exceed 10MB
    const maxSize = 10 * 1024 * 1024;
    const charsNeeded = Math.floor(maxSize / charBytes);
    const content = char.repeat(charsNeeded);
    const size = Buffer.byteLength(content, 'utf8');
    assert.ok(size <= maxSize, `Size ${size} should be <= ${maxSize}`);
    assert.ok(size > maxSize - 10, `Size ${size} should be near ${maxSize}`);

    const result = await mod.execute({ path: LARGE_TEST_FILE, content, overwrite: true });
    assert.ok(result.includes('File written'));
  });

  it('rejects multi-byte UTF-8 content just over 10MB', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const char = '\u4e16'; // 3 bytes in UTF-8
    const charBytes = Buffer.byteLength(char, 'utf8');
    const maxSize = 10 * 1024 * 1024;
    const charsNeeded = Math.floor(maxSize / charBytes) + 1; // one more char over
    const content = char.repeat(charsNeeded);
    const size = Buffer.byteLength(content, 'utf8');
    assert.ok(size > maxSize, `Size ${size} should be > ${maxSize}`);

    await assert.rejects(() => mod.execute({ path: TEST_FILE, content }), /File too large/);
  });

  it('handles rapid consecutive writes without exhaustion', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const tempFiles = [];
    try {
      // Rapidly write 20 small files to test for disk exhaustion issues
      for (let i = 0; i < 20; i++) {
        const filePath = path.join(FIXTURES, `rapid-write-${i}.txt`);
        tempFiles.push(filePath);
        const result = await mod.execute({ path: filePath, content: `data-${i}` });
        assert.ok(result.includes('File written'));
      }
      // Verify all files exist
      for (const fp of tempFiles) {
        const content = await fs.readFile(fp, 'utf8');
        assert.ok(content.startsWith('data-'));
      }
    } finally {
      // Cleanup
      for (const fp of tempFiles) {
        await fs.rm(fp, { force: true });
      }
    }
  });

  it('returns metadata about the written file', async () => {
    const mod = await import('../../../src/tools/file/write.js');
    const result = await mod.execute({ path: TEST_FILE, content: 'test data', overwrite: true });
    assert.ok(result.includes('Absolute path'));
    assert.ok(result.includes('Bytes written'));
  });
});

describe('write.js — overwrite guard and fileState', () => {
  let mod;
  let hashContent;
  let tmpDir;

  before(async () => {
    mod = await import('../../../src/tools/file/write.js');
    hashContent = (await import('../../../src/core/file-state.js')).hashContent;
    const fsP = await import('node:fs/promises');
    const os = await import('node:os');
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'write-state-test-'));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx() {
    return { agent: { fileState: new Map(), currentTurn: 7, trustedPaths: new Set([tmpDir]) } };
  }

  it('writes a new file without ctx.agent (legacy callers)', async () => {
    const file = path.join(FIXTURES, 'write-state-legacy.txt');
    await fs.rm(file, { force: true });
    try {
      const result = await mod.execute({ path: file, content: 'hello' });
      assert.ok(result.includes('File written'));
      const onDisk = await fs.readFile(file, 'utf8');
      assert.equal(onDisk, 'hello');
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('writing a new path populates fileState', async () => {
    const ctx = makeCtx();
    const file = path.join(tmpDir, 'new.txt');
    await mod.execute({ path: file, content: 'a\nb\nc' }, ctx);
    const entry = ctx.agent.fileState.get(file);
    assert.ok(entry, 'expected fileState entry to be created');
    assert.equal(entry.hash, hashContent('a\nb\nc'));
    assert.equal(entry.lastReadTurn, 7);
    assert.equal(entry.totalLines, 3);
    assert.deepEqual(entry.rangesRead, [[1, 3]]);
  });

  it('refuses to overwrite an existing file without overwrite=true', async () => {
    const ctx = makeCtx();
    const file = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(file, 'old', 'utf8');
    await assert.rejects(() => mod.execute({ path: file, content: 'new' }, ctx), /already exists/);
    const onDisk = await fs.readFile(file, 'utf8');
    assert.equal(onDisk, 'old');
  });

  it('overwrites an existing file when overwrite=true and updates state', async () => {
    const ctx = makeCtx();
    const file = path.join(tmpDir, 'overwrite.txt');
    await fs.writeFile(file, 'old', 'utf8');
    const result = await mod.execute({ path: file, content: 'new\nlines', overwrite: true }, ctx);
    assert.ok(result.includes('File written'));
    const onDisk = await fs.readFile(file, 'utf8');
    assert.equal(onDisk, 'new\nlines');
    const entry = ctx.agent.fileState.get(file);
    assert.equal(entry.hash, hashContent('new\nlines'));
    assert.equal(entry.totalLines, 2);
  });
});
