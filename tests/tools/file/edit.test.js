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

describe('Edit — replace action', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/file/edit.js')).execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('replaces old_text (single edit)', async () => {
    const result = await execute({
      path: TEST_FILE,
      edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' }],
    });
    assert.ok(result.includes('updated successfully'));
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(!content.includes('foo bar'));
  });

  it('replaces line range via start_line/end_line', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'replace', start_line: 2, end_line: 4, new_text: 'REPLACED LINES' }],
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
        { action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' },
        { action: 'replace', old_text: 'baz qux', new_text: 'BAZ QUX' },
      ],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(content.includes('BAZ QUX'));
  });

  it('throws edit[0] when old_text not found', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: 'NOTEXIST', new_text: 'x' }] }),
      /edit\[0\]: 'old_text' not found/,
    );
  });

  it('throws edit[0] when old_text appears multiple times', async () => {
    await fs.writeFile(TEST_FILE, 'dup\ndup\nother', 'utf8');
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: 'dup', new_text: 'x' }] }),
      /edit\[0\]: 'old_text' found multiple times/,
    );
  });

  it('throws when replace missing new_text', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: 'foo bar' }] }),
      /edit\[0\]: replace requires 'new_text'/,
    );
  });

  it('throws when replace has no anchor', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', new_text: 'x' }] }),
      /edit\[0\]: replace requires 'old_text' or 'start_line'\+'end_line'/,
    );
  });

  it('replaces new_text containing $& literally without interpolation', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'replace', old_text: 'foo bar', new_text: '$&-literal' }],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('$&-literal'));
    assert.ok(!content.includes('foo bar-literal'));
  });

  it('throws when start_line exceeds end_line', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', start_line: 5, end_line: 2, new_text: 'x' }] }),
      /edit\[0\]: start_line \(5\) must not exceed end_line \(2\)/,
    );
  });
});

describe('Edit — insert action', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/file/edit.js')).execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('inserts before line containing anchor_text', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', anchor_text: 'Line two', position: 'before', text: 'INSERTED' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line one: hello world');
    assert.equal(lines[1], 'INSERTED');
    assert.equal(lines[2], 'Line two: foo bar');
  });

  it('inserts after line containing anchor_text', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', anchor_text: 'Line two', position: 'after', text: 'INSERTED' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[1], 'Line two: foo bar');
    assert.equal(lines[2], 'INSERTED');
    assert.equal(lines[3], 'Line three: baz qux');
  });

  it('inserts before a line number', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', line: 3, position: 'before', text: 'BEFORE THREE' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[2], 'BEFORE THREE');
    assert.equal(lines[3], 'Line three: baz qux');
  });

  it('inserts after a line number', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'insert', line: 2, position: 'after', text: 'AFTER TWO' }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[1], 'Line two: foo bar');
    assert.equal(lines[2], 'AFTER TWO');
    assert.equal(lines[3], 'Line three: baz qux');
  });

  it('throws when anchor_text not found', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [{ action: 'insert', anchor_text: 'NOTEXIST', position: 'after', text: 'x' }],
        }),
      /edit\[0\]: 'anchor_text' not found/,
    );
  });

  it('throws when line is out of range', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'insert', line: 999, position: 'after', text: 'x' }] }),
      /edit\[0\]: line 999 is out of range/,
    );
  });

  it('throws when insert has no anchor', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'insert', position: 'after', text: 'x' }] }),
      /edit\[0\]: insert requires 'anchor_text' or 'line'/,
    );
  });

  it('throws when position is invalid', async () => {
    await assert.rejects(
      () =>
        execute({
          path: TEST_FILE,
          edits: [{ action: 'insert', anchor_text: 'Line two', position: 'middle', text: 'x' }],
        }),
      /edit\[0\]: insert requires 'position'/,
    );
  });
});

describe('Edit — delete action', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/file/edit.js')).execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('deletes matched old_text substring', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'delete', old_text: 'foo bar' }],
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(!content.includes('foo bar'));
    assert.ok(content.includes('Line two:'));
  });

  it('deletes line range via start_line/end_line', async () => {
    await execute({
      path: TEST_FILE,
      edits: [{ action: 'delete', start_line: 2, end_line: 3 }],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line one: hello world');
    assert.equal(lines[1], 'Line four: lorem ipsum');
  });

  it('throws when old_text not found', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete', old_text: 'NOTEXIST' }] }),
      /edit\[0\]: 'old_text' not found/,
    );
  });

  it('throws when old_text appears multiple times', async () => {
    await fs.writeFile(TEST_FILE, 'dup\ndup\nother', 'utf8');
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete', old_text: 'dup' }] }),
      /edit\[0\]: 'old_text' found multiple times/,
    );
  });

  it('throws when delete has no anchor', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete' }] }),
      /edit\[0\]: delete requires 'old_text' or 'start_line'\+'end_line'/,
    );
  });
});

describe('Edit — multi-action and edge cases', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/file/edit.js')).execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('applies replace + insert + delete in one call', async () => {
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' },
        { action: 'insert', anchor_text: 'Line three', position: 'after', text: 'INSERTED' },
        { action: 'delete', old_text: 'lorem ipsum' },
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
          { action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' },
          { action: 'replace', old_text: 'NONEXISTENT', new_text: 'x' },
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
            { action: 'replace', old_text: 'foo bar', new_text: 'x' },
            { action: 'replace', old_text: 'NOTFOUND', new_text: 'y' },
          ],
        }),
      /edit\[1\]: 'old_text' not found/,
    );
  });

  it('throws for unknown action', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'upsert', old_text: 'x', new_text: 'y' }] }),
      /edit\[0\]: unknown action 'upsert'/,
    );
  });

  it('throws when edits array is empty', async () => {
    await assert.rejects(() => execute({ path: TEST_FILE, edits: [] }), /edits must not be empty/);
  });

  it('multi-edit: line-based delete then line-based replace targets correct original line', async () => {
    // Deleting lines 1-2 shifts the file by -2. original line 4 must land at
    // adjusted position 2 in the mutated content.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'delete', start_line: 1, end_line: 2 },
        { action: 'replace', start_line: 4, end_line: 4, new_text: 'REPLACED' },
      ],
    });
    const lines = (await fs.readFile(TEST_FILE, 'utf8')).split('\n');
    assert.equal(lines[0], 'Line three: baz qux');
    assert.equal(lines[1], 'REPLACED');
    assert.equal(lines[2], 'Line five: dolor sit amet');
    assert.equal(lines.length, 3);
  });

  it('multi-edit: line-based insert then line-based replace targets correct original line', async () => {
    // Inserting after line 2 shifts the file by +1. original line 4 must land
    // at adjusted position 5 in the mutated content.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'insert', line: 2, position: 'after', text: 'INSERTED' },
        { action: 'replace', start_line: 4, end_line: 4, new_text: 'REPLACED' },
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

  it('multi-edit: old_text replace then line-based replace — zero delta keeps line numbers intact', async () => {
    // old_text replace on "foo bar" → "FOO BAR": same line count, delta=0.
    // Subsequent line-based replace at original line 4 must not be shifted.
    await execute({
      path: TEST_FILE,
      edits: [
        { action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' },
        { action: 'replace', start_line: 4, end_line: 4, new_text: 'REPLACED' },
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
            { action: 'replace', start_line: 4, end_line: 4, new_text: 'X' },
            { action: 'delete', start_line: 2, end_line: 2 },
          ],
        }),
      /edit\[1\]: line-based edits must be ordered top-to-bottom/,
    );
  });
});

describe('Edit — shell metacharacter path resistance', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    execute = (await import('../../../src/tools/file/edit.js')).execute;
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

  it('handles $(id) in path — does not execute id', async () => {
    const filePath = await makeShellFile('edit-shell-dollar-sub-$(id).txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', old_text: 'original', new_text: 'REPLACED' }],
      });
      assert.ok(result.includes('updated successfully'));
      assert.ok(!result.includes('uid='));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('handles backticks in path — does not execute command', async () => {
    const filePath = await makeShellFile('edit-shell-backtick-`whoami`.txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', old_text: 'original', new_text: 'REPLACED' }],
      });
      assert.ok(result.includes('updated successfully'));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it('handles semicolon in path — does not chain commands', async () => {
    const filePath = await makeShellFile('edit-shell-semicolon-;rm-test.txt');
    try {
      const result = await execute({
        path: filePath,
        edits: [{ action: 'replace', old_text: 'original', new_text: 'REPLACED' }],
      });
      assert.ok(result.includes('updated successfully'));
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
        edits: [{ action: 'replace', old_text: 'original', new_text: 'REPLACED' }],
      });
      assert.ok(result.includes('updated successfully'));
      assert.ok((await fs.readFile(filePath, 'utf8')).includes('REPLACED'));
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
});

describe('Edit — fileState read-before-edit guard', () => {
  let execute;
  let hashContent;
  let tmpDir;
  let tmpFile;

  before(async () => {
    execute = (await import('../../../src/tools/file/edit.js')).execute;
    hashContent = (await import('../../../src/core/file-state.js')).hashContent;
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
      () => execute({ path: tmpFile, edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'X' }] }, ctx),
      /has not been read/,
    );
  });

  it('succeeds when prior state hash matches current file', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const state = new Map();
    state.set(tmpFile, { hash: hashContent(raw), lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    const result = await execute(
      { path: tmpFile, edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'X' }] },
      ctx,
    );
    assert.ok(result.includes('updated successfully'));
  });

  it('throws when file has been modified since last read (hash mismatch)', async () => {
    const state = new Map();
    state.set(tmpFile, { hash: 'deadbeef'.repeat(8), lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    await assert.rejects(
      () => execute({ path: tmpFile, edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'X' }] }, ctx),
      /modified since last read/,
    );
  });

  it('updates fileState with new hash after a successful edit', async () => {
    const raw = await fs.readFile(tmpFile, 'utf8');
    const initialHash = hashContent(raw);
    const state = new Map();
    state.set(tmpFile, { hash: initialHash, lastReadTurn: 1, rangesRead: [[1, 5]], totalLines: 5 });
    const ctx = makeCtx(state);
    await execute({ path: tmpFile, edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' }] }, ctx);
    const entry = state.get(tmpFile);
    const finalRaw = await fs.readFile(tmpFile, 'utf8');
    assert.equal(entry.hash, hashContent(finalRaw));
    assert.notEqual(entry.hash, initialHash);
    assert.equal(entry.lastReadTurn, 4);
    assert.deepEqual(entry.rangesRead, [[1, entry.totalLines]]);
  });

  it('works without ctx.agent (legacy callers, no state checks)', async () => {
    const legacyFile = path.join(FIXTURES, 'edit-state-legacy.txt');
    await fs.writeFile(legacyFile, INITIAL, 'utf8');
    try {
      const result = await execute({
        path: legacyFile,
        edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'OK' }],
      });
      assert.ok(result.includes('updated successfully'));
    } finally {
      await fs.rm(legacyFile, { force: true });
    }
  });
});

describe('Edit — CRLF line endings', () => {
  let execute;
  let crlfFile;

  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    execute = (await import('../../../src/tools/file/edit.js')).execute;
    crlfFile = path.join(FIXTURES, 'edit-crlf.txt');
  });

  after(() => fs.rm(crlfFile, { force: true }));

  beforeEach(async () => {
    // write file with Windows CRLF line endings
    await fs.writeFile(crlfFile, 'Line one: hello world\r\nLine two: foo bar\r\nLine three: baz qux\r\n', 'utf8');
  });

  it('matches old_text with LF in a CRLF file', async () => {
    const result = await execute({
      path: crlfFile,
      edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' }],
    });
    assert.ok(result.includes('updated successfully'));
    const content = await fs.readFile(crlfFile, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(!content.includes('foo bar'));
  });

  it('matches multi-line old_text with LF in a CRLF file', async () => {
    const result = await execute({
      path: crlfFile,
      edits: [{ action: 'replace', old_text: 'Line two: foo bar\nLine three: baz qux', new_text: 'REPLACED' }],
    });
    assert.ok(result.includes('updated successfully'));
    const content = await fs.readFile(crlfFile, 'utf8');
    assert.ok(content.includes('REPLACED'));
  });

  it('preserves CRLF line endings in written output', async () => {
    await execute({
      path: crlfFile,
      edits: [{ action: 'replace', old_text: 'foo bar', new_text: 'FOO BAR' }],
    });
    const raw = await fs.readFile(crlfFile, 'utf8');
    assert.strictEqual(raw, 'Line one: hello world\r\nLine two: FOO BAR\r\nLine three: baz qux\r\n');
  });
});

describe('Edit — preserves untouched content', () => {
  let execute;
  let wsFile;

  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    execute = (await import('../../../src/tools/file/edit.js')).execute;
    wsFile = path.join(FIXTURES, 'edit-whitespace.txt');
  });

  after(() => fs.rm(wsFile, { force: true }));

  beforeEach(async () => {
    // trailing spaces are intentional (markdown hard breaks)
    await fs.writeFile(wsFile, 'first line  \nmarkdown break  \ntarget line\nlast line\n', 'utf8');
  });

  it('keeps trailing whitespace on untouched lines', async () => {
    await execute({
      path: wsFile,
      edits: [{ action: 'replace', old_text: 'target line', new_text: 'CHANGED line' }],
    });
    const raw = await fs.readFile(wsFile, 'utf8');
    assert.strictEqual(raw, 'first line  \nmarkdown break  \nCHANGED line\nlast line\n');
  });

  it('matches old_text that contains trailing whitespace', async () => {
    const result = await execute({
      path: wsFile,
      edits: [{ action: 'replace', old_text: 'markdown break  \n', new_text: 'plain break\n' }],
    });
    assert.ok(result.includes('updated successfully'));
    const raw = await fs.readFile(wsFile, 'utf8');
    assert.ok(raw.includes('plain break\n'));
    assert.ok(raw.includes('first line  \n'), 'untouched trailing whitespace should survive');
  });
});

describe('Edit — error message quality', () => {
  let execute;
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await reset();
    execute = (await import('../../../src/tools/file/edit.js')).execute;
  });
  after(() => fs.rm(TEST_FILE, { force: true }));
  beforeEach(reset);

  it('not-found error includes snippet of searched text', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: 'NOTEXIST', new_text: 'x' }] }),
      /Searched for: "NOTEXIST"/,
    );
  });

  it('not-found error includes whitespace tip', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: 'NOTEXIST', new_text: 'x' }] }),
      /Tip: check for trailing whitespace/,
    );
  });

  it('truncates old_text to 60 chars with ellipsis in not-found error', async () => {
    const longText = 'A'.repeat(80);
    let caught;
    try {
      await execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: longText, new_text: 'x' }] });
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
      () => execute({ path: TEST_FILE, edits: [{ action: 'replace', old_text: 'dup', new_text: 'x' }] }),
      /Searched for: "dup"/,
    );
  });

  it('delete not-found error includes snippet and tip', async () => {
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [{ action: 'delete', old_text: 'NOTEXIST' }] }),
      /Searched for: "NOTEXIST"/,
    );
  });
});
