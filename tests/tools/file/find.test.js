import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures/find-test-dir');

describe('find.js execute', () => {
  before(async () => {
    await fs.mkdir(path.join(FIXTURES, 'sub'), { recursive: true });
    await fs.writeFile(path.join(FIXTURES, 'alpha.txt'), 'content alpha: hello world', 'utf8');
    await fs.writeFile(path.join(FIXTURES, 'beta.md'), 'content beta: foo bar', 'utf8');
    await fs.writeFile(path.join(FIXTURES, 'sub', 'gamma.txt'), 'content gamma: hello again', 'utf8');
    await fs.writeFile(path.join(FIXTURES, 'sub', 'delta.log'), 'delta data', 'utf8');
  });

  after(async () => {
    await fs.rm(FIXTURES, { recursive: true, force: true });
  });

  it('finds files by name pattern (mode=name)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    const result = await mod.execute({
      path: FIXTURES,
      pattern: 'alpha',
      mode: 'name',
    });
    assert.ok(result.includes('alpha.txt'));
    assert.ok(!result.includes('beta'));
  });

  it('finds files by content pattern (mode=content)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    const result = await mod.execute({
      path: FIXTURES,
      pattern: 'hello',
      mode: 'content',
    });
    assert.ok(result.includes('alpha.txt'));
    assert.ok(result.includes('gamma.txt'));
  });

  it('returns "No matches found" when nothing matches (name mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    const result = await mod.execute({
      path: FIXTURES,
      pattern: 'zzznonexistent',
      mode: 'name',
    });
    assert.strictEqual(result, 'No matches found.');
  });

  it('returns "No matches found" when nothing matches (content mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    const result = await mod.execute({
      path: FIXTURES,
      pattern: 'zzznonexistent',
      mode: 'content',
    });
    assert.strictEqual(result, 'No matches found.');
  });

  it('finds by name using regex patterns', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    const result = await mod.execute({
      path: FIXTURES,
      pattern: '\\.txt$',
      mode: 'name',
    });
    assert.ok(result.includes('alpha.txt'));
    assert.ok(result.includes('gamma.txt'));
    assert.ok(!result.includes('beta.md'));
  });
});
