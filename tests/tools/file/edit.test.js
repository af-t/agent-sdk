import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures');
const TEST_FILE = path.join(FIXTURES, 'edit-test-file.txt');

describe('edit.js execute', () => {
  before(async () => {
    await fs.mkdir(FIXTURES, { recursive: true });
    await fs.writeFile(
      TEST_FILE,
      [
        'Line one: hello world',
        'Line two: foo bar',
        'Line three: baz qux',
        'Line four: lorem ipsum',
        'Line five: dolor sit amet',
      ].join('\n'),
      'utf8'
    );
  });

  after(async () => {
    await fs.rm(TEST_FILE, { force: true });
  });

  it('replaces old_text with new_text', async () => {
    // Re-read fresh content before each test
    await fs.writeFile(
      TEST_FILE,
      [
        'Line one: hello world',
        'Line two: foo bar',
        'Line three: baz qux',
        'Line four: lorem ipsum',
        'Line five: dolor sit amet',
      ].join('\n'),
      'utf8'
    );
    const mod = await import('../../../src/tools/file/edit.js');
    const result = await mod.execute({
      path: TEST_FILE,
      old_text: 'foo bar',
      new_text: 'FOO BAR',
    });
    assert.ok(result.includes('updated successfully'));
    const content = await fs.readFile(TEST_FILE, 'utf8');
    assert.ok(content.includes('FOO BAR'));
    assert.ok(!content.includes('foo bar'));
  });

  it('replaces a range using start_line/end_line', async () => {
    await fs.writeFile(
      TEST_FILE,
      [
        'Line one: hello world',
        'Line two: foo bar',
        'Line three: baz qux',
        'Line four: lorem ipsum',
        'Line five: dolor sit amet',
      ].join('\n'),
      'utf8'
    );
    const mod = await import('../../../src/tools/file/edit.js');
    await mod.execute({
      path: TEST_FILE,
      start_line: 2,
      end_line: 4,
      new_text: 'REPLACED LINES',
    });
    const content = await fs.readFile(TEST_FILE, 'utf8');
    const lines = content.split('\n');
    assert.strictEqual(lines[0], 'Line one: hello world');
    assert.strictEqual(lines[1], 'REPLACED LINES');
    assert.strictEqual(lines[2], 'Line five: dolor sit amet');
  });

  it('throws when old_text is not found', async () => {
    const mod = await import('../../../src/tools/file/edit.js');
    await assert.rejects(
      () => mod.execute({
        path: TEST_FILE,
        old_text: 'NONEXISTENT TEXT HERE',
        new_text: 'irrelevant',
      }),
      /'old_text' not found/
    );
  });

  it('throws when old_text appears multiple times', async () => {
    await fs.writeFile(
      TEST_FILE,
      'duplicate\nduplicate\nother',
      'utf8'
    );
    const mod = await import('../../../src/tools/file/edit.js');
    await assert.rejects(
      () => mod.execute({
        path: TEST_FILE,
        old_text: 'duplicate',
        new_text: 'single',
      }),
      /'old_text' found multiple times/
    );
  });

  it('throws when neither old_text nor start_line/end_line provided', async () => {
    await fs.writeFile(
      TEST_FILE,
      'some content',
      'utf8'
    );
    const mod = await import('../../../src/tools/file/edit.js');
    await assert.rejects(
      () => mod.execute({
        path: TEST_FILE,
        new_text: 'replacement',
      }),
      /Either 'old_text' or both 'start_line' and 'end_line'/
    );
  });
});
