import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures/list-test-dir');

describe('list.js execute', () => {
  before(async () => {
    await fs.mkdir(path.join(FIXTURES, 'subdir'), { recursive: true });
    await fs.writeFile(path.join(FIXTURES, 'file_a.txt'), 'aaa', 'utf8');
    await fs.writeFile(path.join(FIXTURES, 'file_b.txt'), 'bbb', 'utf8');
    await fs.writeFile(path.join(FIXTURES, 'subdir', 'nested.txt'), 'nested', 'utf8');
  });

  after(async () => {
    await fs.rm(FIXTURES, { recursive: true, force: true });
  });

  it('lists files at the given path (depth=1)', async () => {
    const mod = await import('../../../src/tools/file/list.js');
    const result = await mod.execute({ path: FIXTURES });
    assert.ok(result.includes('file_a.txt'));
    assert.ok(result.includes('file_b.txt'));
    assert.ok(result.includes('subdir/'));
    // At depth=1 (default), list walks 1 level deep, so nested.txt IS included
    assert.ok(result.includes('nested.txt'));
  });

  it('lists nested files with depth > 1', async () => {
    const mod = await import('../../../src/tools/file/list.js');
    const result = await mod.execute({ path: FIXTURES, depth: 2 });
    assert.ok(result.includes('file_a.txt'));
    assert.ok(result.includes('subdir/'));
    assert.ok(result.includes('nested.txt'));
  });

  it('returns "(Empty directory)" for an empty directory', async () => {
    const emptyDir = path.join(FIXTURES, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const mod = await import('../../../src/tools/file/list.js');
    const result = await mod.execute({ path: emptyDir });
    assert.strictEqual(result, '(Empty directory)');
    await fs.rm(emptyDir, { recursive: true, force: true });
  });

  it('includes file sizes in output', async () => {
    const mod = await import('../../../src/tools/file/list.js');
    const result = await mod.execute({ path: FIXTURES });
    // file_a.txt has 3 bytes content => "3B"
    assert.ok(result.includes('(3B)'));
  });

  it('throws for non-existent directory within project root', async () => {
    const mod = await import('../../../src/tools/file/list.js');
    await assert.rejects(
      () => mod.execute({ path: 'tests/fixtures/nonexistent-dir-xyz' }),
      { code: 'ENOENT' }
    );
  });
});
