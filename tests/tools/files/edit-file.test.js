import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures');
const TEST_FILE = path.join(FIXTURES, 'edit-test-file.txt');

const INITIAL = [
  'Line one: hello world',
  'Line two: foo bar',
  'Line three: baz qux',
  'Line four: lorem ipsum',
  'Line five: dolor sit amet',
].join('\n');

async function reset() {
  await fs.writeFile(TEST_FILE, INITIAL, 'utf8');
}

describe('editFile: replace action', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('replaces oldText (single edit)', async () => {
    const result = await execute({
      path: TEST_FILE,
      edits: [{ action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' }],
    });
    assert.ok(result.includes('Updated'));
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(!content.includes('foo bar'));
  });

  it('replaces line range via startLine/endLine', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'replace', startLine: 2, endLine: 4, newText: 'REPLACED LINES' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line one: hello world');
    assert.equal(lines[1], 'REPLACED LINES');
    assert.equal(lines[2], 'Line five: dolor sit amet');
  });

  it('applies multiple replaces sequentially', async () => {
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' },
        { action: 'replace', oldText: 'baz qux', newText: 'BAZ QUX' },
      ],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(content.includes('BAZ QUX'));
  });

  it('throws edit[0] when oldText not found', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: 'NOTEXIST', newText: 'x' }] }),
      /edit\[0\]: 'oldText' not found/,
    );
  });

  it('throws edit[0] when oldText appears multiple times', async () => {
    await fs.writeFile(TEST_FILE, 'dup\ndup\nother', 'utf8');
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: 'dup', newText: 'x' }] }),
      /edit\[0\]: 'oldText' found multiple times/,
    );
  });

  it('throws when replace missing newText', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: 'foo bar' }] }),
      /edit\[0\]: replace requires 'newText'/,
    );
  });

  it('throws when replace has no anchor', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', newText: 'x' }] }),
      /edit\[0\]: replace requires 'oldText' or 'startLine'\+'endLine'/,
    );
  });

  it('replaces newText containing $& literally without interpolation', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'replace', oldText: 'foo bar', newText: '$&-literal' }],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('$&-literal'));
    assert.ok(!content.includes('foo bar-literal'));
  });

  it('throws when startLine exceeds endLine', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', startLine: 5, endLine: 2, newText: 'x' }] }),
      /edit\[0\]: startLine \(5\) must not exceed endLine \(2\)/,
    );
  });
});

describe('editFile: insert action', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('inserts before line containing anchorText', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', anchorText: 'Line two', position: 'before', newText: 'INSERTED' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line one: hello world');
    assert.equal(lines[1], 'INSERTED');
    assert.equal(lines[2], 'Line two: foo bar');
  });

  it('inserts after line containing anchorText', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', anchorText: 'Line two', position: 'after', newText: 'INSERTED' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[1], 'Line two: foo bar');
    assert.equal(lines[2], 'INSERTED');
    assert.equal(lines[3], 'Line three: baz qux');
  });

  it('inserts before a line number', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', startLine: 3, position: 'before', newText: 'BEFORE THREE' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[2], 'BEFORE THREE');
    assert.equal(lines[3], 'Line three: baz qux');
  });

  it('inserts after a line number', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', startLine: 2, position: 'after', newText: 'AFTER TWO' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[1], 'Line two: foo bar');
    assert.equal(lines[2], 'AFTER TWO');
    assert.equal(lines[3], 'Line three: baz qux');
  });

  it('throws when anchorText not found', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [{ action: 'insert', anchorText: 'NOTEXIST', position: 'after', newText: 'x' }],
        }),
      /edit\[0\]: 'anchorText' not found/,
    );
  });

  it('throws when line is out of range', async () => {
    await assert.rejects(
      () =>
        execute({ path: TEST_FILE, edits: [{ action: 'insert', startLine: 999, position: 'after', newText: 'x' }] }),
      /edit\[0\]: line 999 is out of range/,
    );
  });

  it('throws when insert has no anchor', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'insert', position: 'after', newText: 'x' }] }),
      /edit\[0\]: insert requires 'anchorText' or 'startLine'/,
    );
  });

  it('throws when position is invalid', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [{ action: 'insert', anchorText: 'Line two', position: 'middle', newText: 'x' }],
        }),
      /edit\[0\]: insert requires 'position'/,
    );
  });
});

describe('editFile: delete action', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('deletes matched oldText substring', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'delete', oldText: 'foo bar' }],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(!content.includes('foo bar'));
    assert.ok(content.includes('Line two:'));
  });

  it('deletes line range via startLine/endLine', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'delete', startLine: 2, endLine: 3 }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line one: hello world');
    assert.equal(lines[1], 'Line four: lorem ipsum');
  });

  it('throws when oldText not found', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete', oldText: 'NOTEXIST' }] }),
      /edit\[0\]: 'oldText' not found/,
    );
  });

  it('throws when oldText appears multiple times', async () => {
    await fs.writeFile(TEST_FILE, 'dup\ndup\nother', 'utf8');
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete', oldText: 'dup' }] }),
      /edit\[0\]: 'oldText' found multiple times/,
    );
  });

  it('throws when delete has no anchor', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete' }] }),
      /edit\[0\]: delete requires 'oldText' or 'startLine'\+'endLine'/,
    );
  });
});

describe('editFile: multi-action and edge cases', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('applies replace + insert + delete in one call', async () => {
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' },
        { action: 'insert', anchorText: 'Line three', position: 'after', newText: 'INSERTED' },
        { action: 'delete', oldText: 'lorem ipsum' },
      ],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(content.includes('INSERTED'));
    assert.ok(!content.includes('lorem ipsum'));
  });

  it('does not modify file when a mid-array edit fails', async () => {
    const original = await fs.readFile(TEST_FILE, 'utf8');
    await assert.rejects(() =>
      execute({
        path: TEST_FILE,
        edits: [
          { action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' },
          { action: 'replace', oldText: 'NONEXISTENT', newText: 'x' },
        ],
      }),
    );
    const after = await fs.readFile(TEST_FILE, 'utf8');
    assert.equal(after, original);
  });

  it('error message includes correct index for mid-array failure', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [
            { action: 'replace', oldText: 'foo bar', newText: 'x' },
            { action: 'replace', oldText: 'NOTFOUND', newText: 'y' },
          ],
        }),
      /edit\[1\]: 'oldText' not found/,
    );
  });

  it('throws for unknown action', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'upsert', oldText: 'x', newText: 'y' }] }),
      /edit\[0\]: unknown action 'upsert'/,
    );
  });

  it('throws when edits array is empty', async () => {
    await assert.rejects(() => execute({ path: TEST_FILE, edits: [] }), /edits must not be empty/);
  });

  it('multi-edit: line-based delete then line-based replace targets correct original line', async () => {
    // Deleting lines 1-2 moves original line 4 to position 2.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'delete', startLine: 1, endLine: 2 },
        { action: 'replace', startLine: 4, endLine: 4, newText: 'REPLACED' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line three: baz qux');
    assert.equal(lines[1], 'REPLACED');
    assert.equal(lines[2], 'Line five: dolor sit amet');
    assert.equal(lines.length, 3);
  });

  it('multi-edit: line-based insert then line-based replace targets correct original line', async () => {
    // Inserting after line 2 moves original line 4 to position 5.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'insert', startLine: 2, position: 'after', newText: 'INSERTED' },
        { action: 'replace', startLine: 4, endLine: 4, newText: 'REPLACED' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line one: hello world');
    assert.equal(lines[1], 'Line two: foo bar');
    assert.equal(lines[2], 'INSERTED');
    assert.equal(lines[3], 'Line three: baz qux');
    assert.equal(lines[4], 'REPLACED');
    assert.equal(lines[5], 'Line five: dolor sit amet');
    assert.equal(lines.length, 6);
  });

  it('multi-edit: oldText replace then line-based replace: zero delta keeps line numbers intact', async () => {
    // Replacing "foo bar" with "FOO BAR" keeps the same line count.
    // The following line-based replacement still targets original line 4.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' },
        { action: 'replace', startLine: 4, endLine: 4, newText: 'REPLACED' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.ok(lines[1].includes('FOO BAR'), 'line 2 should contain replaced text');
    assert.equal(lines[3], 'REPLACED');
  });

  it('throws when line-based edits are specified out of order', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [
            { action: 'replace', startLine: 4, endLine: 4, newText: 'X' },
            { action: 'delete', startLine: 2, endLine: 2 },
          ],
        }),
      /edit\[1\]: line-based edits must be ordered top-to-bottom/,
    );
  });
});

describe('editFile: shell metacharacter path resistance', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(async () => {
    try {
      const entries = await fs.readdir(FIXTURES);
      for (const e of entries) {
        if (e.startsWith('edit-shell-')) await fs.rm(path.join(FIXTURES, e), { force: true });
      }
    } catch {}
  });

  async function makeShellFile(name) {
    const filePath = path.join(FIXTURES, name);
    await fs.writeFile(filePath, 'line one: original\nline two: keep me\n', 'utf8');
    return filePath;
  }

  it('handles $(id) in path: does not execute id', async () => {
    const filePath = await makeShellFile('edit-shell-dollar-sub-$(id).txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', oldText: 'original', newText: 'REPLACED' }],
      });
      assert.ok(result.includes('Updated'));
      assert.ok(!result.includes('uid='));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('handles backticks in path: does not execute command', async () => {
    const filePath = await makeShellFile('edit-shell-backtick-`whoami`.txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', oldText: 'original', newText: 'REPLACED' }],
      });
      assert.ok(result.includes('Updated'));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('handles semicolon in path: does not chain commands', async () => {
    const filePath = await makeShellFile('edit-shell-semicolon-;rm-test.txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', oldText: 'original', newText: 'REPLACED' }],
      });
      assert.ok(result.includes('Updated'));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
      await fs.access(filePath);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('handles pipe character in path safely', async () => {
    const filePath = await makeShellFile('edit-shell-pipe-|cat.txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', oldText: 'original', newText: 'REPLACED' }],
      });
      assert.ok(result.includes('Updated'));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
});

describe('editFile: fileState read-before-edit guard', () => {
  let execute;
  let hashContent;
  let tmpDir;
  let tmpFile;

  before(async () => {
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
    hashContent = (await import('../../../src/tools/files/file-state.js')).hashContent;
    const fsP = await import('node:fs/promises');
    const os = await import('node:os');
    tmpDir = await fsP.mkdtemp(path.join(os.tmpdir(), 'edit-state-test-'));
    tmpFile = path.join(tmpDir, 'file.txt');
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await fs.writeFile(tmpFile, INITIAL, 'utf8');
  });

  function makeCtx(state) {
    return { agent: { fileState: state, currentTurn: 4, trustedPaths: new Set([tmpDir]) } };
  }

  it('throws when no prior state exists for the path', async () => {
    const ctx = makeCtx(new Map());
    await assert.rejects(
      () => execute({ path: tmpFile, edits: [{ action: 'replace', oldText: 'foo bar', newText: 'X' }] }, ctx),
      /has not been read/,
    );
  });

  it('succeeds when prior state hash matches current file', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    const result = await execute(
      { path: tmpFile, edits: [{ action: 'replace', oldText: 'foo bar', newText: 'X' }] },
      ctx,
    );
    assert.ok(result.includes('Updated'));
  });

  it('throws when file has been modified since last read (hash mismatch)', async () => {
    const state = new Map();
    state.set(tmpFile, { hash: 'deadbeef'.repeat(8), lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    await assert.rejects(
      () => execute({ path: tmpFile, edits: [{ action: 'replace', oldText: 'foo bar', newText: 'X' }] }, ctx),
      /modified since last read/,
    );
  });

  it('updates fileState with new hash after a successful edit', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const initialHash = hashContent(raw);
    const state = new Map();
    state.set(tmpFile, { hash: initialHash, lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    await execute({ path: tmpFile, edits: [{ action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' }] }, ctx);
    const entry = state.get(tmpFile);
    const finalRaw = await fs.readFile(tmpFile, 'utf8');
    assert.equal(entry.hash, hashContent(finalRaw));
    assert.notEqual(entry.hash, initialHash);
    assert.equal(entry.lastReadTurn, 4);
    assert.deepEqual(entry.rangesRead, [[1, entry.totalLines]]);
  });

  it('works without ctx.agent or state checks', async () => {
    const standaloneFile = path.join(FIXTURES, 'edit-state-standalone.txt');
    await fs.writeFile(standaloneFile, INITIAL, 'utf8');
    try {
      const result = await execute({
        path: standaloneFile,
        edits: [{ action: 'replace', oldText: 'foo bar', newText: 'OK' }],
      });
      assert.ok(result.includes('Updated'));
    } finally {
      await fs.rm(standaloneFile, { force: true });
    }
  });

  it('rejects a line-based replace outside the read range (blind-edit guard)', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[1, 2]], totalLines: 5 });
    const ctx = makeCtx(state);
    await assert.rejects(
      () => execute({ path: tmpFile, edits: [{ action: 'replace', startLine: 4, endLine: 5, newText: 'X' }] }, ctx),
      /lines 4-5 have not been read/,
    );
    // The guard rejects the edit before the file changes.
    assert.equal(await fs.readFile(tmpFile, 'utf8'), INITIAL);
  });

  it('allows a line-based replace within the read range', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    const result = await execute(
      { path: tmpFile, edits: [{ action: 'replace', startLine: 2, endLine: 2, newText: 'Line two: CHANGED' }] },
      ctx,
    );
    assert.ok(result.includes('Updated'));
  });

  it('exempts oldText edits from the range check (content-anchored)', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    // Content-anchored edits can target line 2 when only line 1 was read.
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[1, 1]], totalLines: 5 });
    const ctx = makeCtx(state);
    const result = await execute(
      { path: tmpFile, edits: [{ action: 'replace', oldText: 'foo bar', newText: 'X' }] },
      ctx,
    );
    assert.ok(result.includes('Updated'));
  });

  it('rejects a line-anchored insert on an unread line', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[1, 2]], totalLines: 5 });
    const ctx = makeCtx(state);
    await assert.rejects(
      () =>
        execute({ path: tmpFile, edits: [{ action: 'insert', startLine: 5, position: 'after', newText: 'NEW' }] }, ctx),
      /lines 5-5 have not been read.*anchorText/s,
    );
  });

  it('preserves a partial read range after a successful edit (regression for 6056d27)', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    // This partial range remains partial after the edit.
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[2, 3]], totalLines: 5 });
    const ctx = makeCtx(state);
    await execute({ path: tmpFile, edits: [{ action: 'replace', oldText: 'foo bar', newText: 'FOO' }] }, ctx);
    const entry = state.get(tmpFile);
    assert.deepEqual(entry.rangesRead, [[2, 3]]);
  });
});

describe('editFile: CRLF line endings', () => {
  let execute;
  let crlfFile;

  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
    crlfFile = path.join(FIXTURES, 'edit-crlf.txt');
  });

  after(() => fs.rm(crlfFile, { force: true }));

  beforeEach(async () => {
    // This fixture uses Windows CRLF line endings.
    await fs.writeFile(crlfFile, 'Line one: hello world\r\nLine two: foo bar\r\nLine three: baz qux\r\n', 'utf8');
  });

  it('matches oldText with LF in a CRLF file', async () => {
    const result = await execute({
      path: crlfFile,
      edits: [{ action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' }],
    });
    assert.ok(result.includes('Updated'));
    const content = await fs.readFile(crlfFile, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(!content.includes('foo bar'));
  });

  it('matches multi-line oldText with LF in a CRLF file', async () => {
    const result = await execute({
      path: crlfFile,
      edits: [{ action: 'replace', oldText: 'Line two: foo bar\nLine three: baz qux', newText: 'REPLACED' }],
    });
    assert.ok(result.includes('Updated'));
    const content = await fs.readFile(crlfFile, 'utf8');
    assert.ok(content.includes('REPLACED'));
  });

  it('preserves CRLF line endings in written output', async () => {
    await execute({
      path: crlfFile,
      edits: [{ action: 'replace', oldText: 'foo bar', newText: 'FOO BAR' }],
    });
    const raw = await fs.readFile(crlfFile, 'utf8');
    assert.strictEqual(raw, 'Line one: hello world\r\nLine two: FOO BAR\r\nLine three: baz qux\r\n');
  });
});

describe('editFile: preserves untouched content', () => {
  let execute;
  let wsFile;

  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
    wsFile = path.join(FIXTURES, 'edit-whitespace.txt');
  });

  after(() => fs.rm(wsFile, { force: true }));

  beforeEach(async () => {
    // The trailing spaces represent Markdown hard breaks.
    await fs.writeFile(wsFile, 'first line  \nmarkdown break  \ntarget line\nlast line\n', 'utf8');
  });

  it('keeps trailing whitespace on untouched lines', async () => {
    await execute({
      path: wsFile,
      edits: [{ action: 'replace', oldText: 'target line', newText: 'CHANGED line' }],
    });
    const raw = await fs.readFile(wsFile, 'utf8');
    assert.strictEqual(raw, 'first line  \nmarkdown break  \nCHANGED line\nlast line\n');
  });

  it('matches oldText that contains trailing whitespace', async () => {
    const result = await execute({
      path: wsFile,
      edits: [{ action: 'replace', oldText: 'markdown break  \n', newText: 'plain break\n' }],
    });
    assert.ok(result.includes('Updated'));
    const raw = await fs.readFile(wsFile, 'utf8');
    assert.ok(raw.includes('plain break\n'));
    assert.ok(raw.includes('first line  \n'), 'untouched trailing whitespace should survive');
  });
});

describe('editFile: error message quality', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('not-found error includes snippet of searched text', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: 'NOTEXIST', newText: 'x' }] }),
      /Searched for: "NOTEXIST"/,
    );
  });

  it('not-found error includes whitespace tip', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: 'NOTEXIST', newText: 'x' }] }),
      /Tip: check for trailing whitespace/,
    );
  });

  it('truncates oldText to 60 chars with ellipsis in not-found error', async () => {
    const longText = 'A'.repeat(80);
    let caught;
    try {
      await execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: longText, newText: 'x' }] });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, 'expected error to be thrown');
    const match = caught.message.match(/Searched for: "([^"]+)"/);
    assert.ok(match, 'expected snippet in error message');
    assert.equal(match[1], 'A'.repeat(60) + '…');
  });

  it('multiple-times error includes snippet', async () => {
    await fs.writeFile(TEST_FILE, 'dup\ndup\nother', 'utf8');
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', oldText: 'dup', newText: 'x' }] }),
      /Searched for: "dup"/,
    );
  });

  it('delete not-found error includes snippet and tip', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete', oldText: 'NOTEXIST' }] }),
      /Searched for: "NOTEXIST"/,
    );
  });
});

describe('editFile: mixed content-anchored and line-based edits', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/files/edit-file.js')).editFile.execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('line-based edit above an earlier oldText edit that added lines is not shifted', async () => {
    // An oldText edit that adds a line below startLine 2 cannot move that
    // earlier line-based target.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', oldText: 'Line four: lorem ipsum', newText: 'Line four: lorem ipsum\nLine 4.5: EXTRA' },
        { action: 'replace', startLine: 2, endLine: 2, newText: 'TWO' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.deepEqual(lines, [
      'Line one: hello world',
      'TWO',
      'Line three: baz qux',
      'Line four: lorem ipsum',
      'Line 4.5: EXTRA',
      'Line five: dolor sit amet',
    ]);
  });

  it('line-based edit below an earlier oldText edit that added lines is shifted correctly', async () => {
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', oldText: 'Line two: foo bar', newText: 'Line two: foo bar\nLine 2.5: EXTRA' },
        { action: 'replace', startLine: 4, endLine: 4, newText: 'FOUR' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.deepEqual(lines, [
      'Line one: hello world',
      'Line two: foo bar',
      'Line 2.5: EXTRA',
      'Line three: baz qux',
      'FOUR',
      'Line five: dolor sit amet',
    ]);
  });

  it('line-based edit below an earlier oldText delete is shifted correctly', async () => {
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'delete', oldText: 'Line two: foo bar\n' },
        { action: 'replace', startLine: 4, endLine: 4, newText: 'FOUR' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.deepEqual(lines, ['Line one: hello world', 'Line three: baz qux', 'FOUR', 'Line five: dolor sit amet']);
  });

  it('insert by line number below an earlier oldText edit is shifted correctly', async () => {
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', oldText: 'Line one: hello world', newText: 'ONE\nONE-B' },
        { action: 'insert', startLine: 3, position: 'after', newText: 'INSERTED' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.deepEqual(lines, [
      'ONE',
      'ONE-B',
      'Line two: foo bar',
      'Line three: baz qux',
      'INSERTED',
      'Line four: lorem ipsum',
      'Line five: dolor sit amet',
    ]);
  });

  it('throws when a line-based edit targets a line rewritten by an earlier oldText edit', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [
            { action: 'replace', oldText: 'Line three: baz qux', newText: 'X\nY' },
            { action: 'replace', startLine: 3, endLine: 3, newText: 'Z' },
          ],
        }),
      /edit\[1\]: line 3 was changed by an earlier edit in this call/,
    );
    // Atomic validation leaves the file unchanged.
    assert.equal(await fs.readFile(TEST_FILE, 'utf8'), INITIAL);
  });

  it('throws when a line-based edit references a line beyond the original file', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [{ action: 'replace', startLine: 9, endLine: 9, newText: 'X' }],
        }),
      /edit\[0\]: line 9 is out of range \(file has 5 lines\)/,
    );
  });

  it('line-based edit on the line immediately after an oldText delete-with-trailing-newline is not falsely invalidated', async () => {
    // oldText 'Line two: foo bar\n' has a trailing newline, so
    // split('\n').length over-counts the whole-line
    // span it touches (one startLine at line 2). Line 3 remains tracked because
    // its content is unchanged.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'delete', oldText: 'Line two: foo bar\n' },
        { action: 'replace', startLine: 3, endLine: 3, newText: 'THREE-REPLACED' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.deepEqual(lines, [
      'Line one: hello world',
      'THREE-REPLACED',
      'Line four: lorem ipsum',
      'Line five: dolor sit amet',
    ]);
  });
});
