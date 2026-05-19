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
    await assert.rejects(() => mod.execute({ path: '/etc/hostname' }, { agent: { trustedPaths: new Set() } }), {
      message: /outside project root/,
    });
  });
});

describe('read.js — fileState caching', () => {
  let mod;
  let tmpDir;
  let tmpFile;

  before(async () => {
    mod = await import('../../../src/tools/file/read.js');
    const fsP = await import('node:fs/promises');
    const os = await import('node:os');
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'read-state-test-'));
    tmpFile = path.join(tmpDir, 'file.txt');
    await fsP.writeFile(tmpFile, Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n'), 'utf8');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeCtx({ turn = 3 } = {}) {
    return { agent: { fileState: new Map(), currentTurn: turn, trustedPaths: new Set([tmpDir]) } };
  }

  it('first read populates fileState and returns numbered content', async () => {
    const ctx = makeCtx();
    const result = await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    assert.ok(result.includes('     1\tLine 1'));
    assert.ok(result.includes('     5\tLine 5'));
    assert.equal(ctx.agent.fileState.size, 1);
    const entry = [...ctx.agent.fileState.values()][0];
    assert.match(entry.hash, /^[0-9a-f]{64}$/);
    assert.equal(entry.lastReadTurn, 3);
    assert.deepEqual(entry.rangesRead, [[1, 5]]);
    assert.equal(entry.totalLines, 20);
  });

  it('repeat read of the same range returns a cache-hit short message', async () => {
    const ctx = makeCtx({ turn: 5 });
    await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    const result = await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    assert.ok(result.startsWith('[CACHED]'));
    assert.ok(result.includes('turn 5'));
    assert.ok(result.includes('Lines 1-5'));
    assert.ok(result.includes('Total: 20'));
  });

  it('disjoint subsequent read returns content and merges rangesRead', async () => {
    const ctx = makeCtx();
    await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    const result = await mod.execute({ path: tmpFile, start_line: 10, end_line: 12 }, ctx);
    assert.ok(!result.startsWith('[CACHED]'));
    assert.ok(result.includes('    10\tLine 10'));
    const entry = [...ctx.agent.fileState.values()][0];
    assert.deepEqual(entry.rangesRead, [
      [1, 5],
      [10, 12],
    ]);
  });

  it('external file modification invalidates cache and replaces ranges', async () => {
    const ctx = makeCtx();
    await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    const entryBefore = [...ctx.agent.fileState.values()][0];
    const firstHash = entryBefore.hash;

    await fs.writeFile(tmpFile, Array.from({ length: 25 }, (_, i) => `New ${i + 1}`).join('\n'), 'utf8');

    const result = await mod.execute({ path: tmpFile, start_line: 1, end_line: 5 }, ctx);
    assert.ok(!result.startsWith('[CACHED]'));
    assert.ok(result.includes('     1\tNew 1'));
    const entryAfter = [...ctx.agent.fileState.values()][0];
    assert.notEqual(entryAfter.hash, firstHash);
    assert.deepEqual(entryAfter.rangesRead, [[1, 5]]);
    assert.equal(entryAfter.totalLines, 25);
  });

  it('works without ctx.agent (legacy callers)', async () => {
    const legacyFile = path.join(FIXTURES, 'read-state-legacy.txt');
    await fs.writeFile(legacyFile, 'a\nb\nc\n', 'utf8');
    try {
      const result = await mod.execute({ path: legacyFile });
      assert.ok(result.includes('     1\ta'));
      assert.ok(result.includes('     3\tc'));
    } finally {
      await fs.rm(legacyFile, { force: true });
    }
  });
});
