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
      () => execute({ path: TEST_FILE, edits: [{ action: 'insert', anchor_text: 'NOTEXIST', position: 'after', text: 'x' }] }),
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
      () => execute({ path: TEST_FILE, edits: [{ action: 'insert', anchor_text: 'Line two', position: 'middle', text: 'x' }] }),
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
    await assert.rejects(
      () => execute({ path: TEST_FILE, edits: [] }),
      /edits must not be empty/,
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
