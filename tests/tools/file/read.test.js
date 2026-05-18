import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures');
const TEST_FILE = path.join(FIXTURES, 'read-test.txt');

describe('read.js execute', () => {
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await fs.writeFile(TEST_FILE, Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n'), 'utf8');
  });

  after(async () => {
    await fs.rm(TEST_FILE, { force: true });
  });

  it('reads an existing file and returns numbered lines', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: TEST_FILE });
    assert.ok(result.includes('     1\tLine 1'));
    assert.ok(result.includes('    20\tLine 20'));
  });

  it('throws for a non-existent file within project root', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    await assert.rejects(() => mod.execute({ path: 'tests/fixtures/nonexistent-file-xyz.txt' }), { code: 'ENOENT' });
  });

  it('supports pagination via start_line / end_line', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: TEST_FILE, start_line: 5, end_line: 10 });
    assert.ok(result.includes('     5\tLine 5'));
    assert.ok(result.includes('     9\tLine 9'));
    // line 10 is included since slice = lines[4:10) = lines 5 through 10
    assert.ok(result.includes('    10\tLine 10'));
    // truncated indicator appears because not all lines were read (end_line < total)
    assert.ok(result.includes('[... truncated]'));
  });

  it('respects max_lines limit', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    const result = await mod.execute({ path: TEST_FILE, max_lines: 3 });
    const lines = result.split('\n').filter((l) => l.trim() && !l.includes('[... truncated]'));
    assert.ok(lines.length <= 3);
  });

  it('shows truncated indicator when not reading entire file', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    // 20 lines total, but reading start_line=1,end_line=5 means only first 5 lines
    const result = await mod.execute({ path: TEST_FILE, start_line: 1, end_line: 5 });
    assert.ok(result.includes('[... truncated]'));
  });

  it('reads a file outside project root when in agent trustedPaths', async () => {
    const fsP = await import('node:fs/promises');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const tmpDir = await fsP.mkdtemp(pathMod.join(os.tmpdir(), 'read-tool-test-'));
    const file = pathMod.join(tmpDir, 'external.txt');
    await fsP.writeFile(file, 'external file content');

    const mod = await import('../../../src/tools/file/read.js');
    const ctx = { agent: { trustedPaths: new Set([tmpDir]) } };
    const result = await mod.execute({ path: file }, ctx);

    assert.ok(result.includes('external file content'));
    await fsP.rm(tmpDir, { recursive: true });
  });

  it('rejects file outside project root with empty trustedPaths', async () => {
    const mod = await import('../../../src/tools/file/read.js');
    await assert.rejects(
      () => mod.execute({ path: '/etc/hostname' }, { agent: { trustedPaths: new Set() } }),
      { message: /outside project root/ },
    );
  });
});
