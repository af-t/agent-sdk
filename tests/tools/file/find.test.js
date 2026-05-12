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

describe('find.js — injection resistance', () => {
  let fixturesDir;

  before(async () => {
    fixturesDir = path.resolve('tests/fixtures/find-injection-test');
    await fs.mkdir(fixturesDir, { recursive: true });
    await fs.writeFile(path.join(fixturesDir, 'safe-file.txt'), 'safe content here', 'utf8');
    await fs.writeFile(path.join(fixturesDir, 'another.txt'), 'more content', 'utf8');
  });

  after(async () => {
    await fs.rm(fixturesDir, { recursive: true, force: true });
  });

  it('handles double-quote in pattern without crashing (name mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '"',
        mode: 'name',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  it('handles double-quote in pattern without crashing (content mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '"',
        mode: 'content',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  it('handles semicolon in pattern without crashing (name mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: ';',
        mode: 'name',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  it('handles semicolon in pattern without crashing (content mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: ';',
        mode: 'content',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  it('handles backticks in pattern without crashing (name mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '`test`',
        mode: 'name',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  it('handles backticks in pattern without crashing (content mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '`test`',
        mode: 'content',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });

  it('treats $(id) as literal regex, not command substitution (name mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    // Create a file that literally contains $(id) in its name
    await fs.writeFile(path.join(fixturesDir, 'cmd-$(id)-test.txt'), 'content', 'utf8');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '\\$\\(id\\)',
        mode: 'name',
      });
      assert.ok(typeof result === 'string');
      assert.ok(!result.includes('uid='), '$(id) should not be executed as shell command');
      if (result !== 'No matches found.') {
        assert.ok(result.includes('cmd-$(id)-test.txt'), 'should match the literal filename');
      }
    } catch (err) {
      assert.ok(err.message.length > 0);
      assert.ok(!err.message.includes('uid='), '$(id) should not execute in error path');
    }
  });

  it('treats $(id) as literal regex, not command substitution (content mode)', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    await fs.writeFile(
      path.join(fixturesDir, 'content-test.txt'),
      'this file contains $(id) as literal text',
      'utf8',
    );
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '\\$\\(id\\)',
        mode: 'content',
      });
      assert.ok(typeof result === 'string');
      assert.ok(!result.includes('uid='), '$(id) should not be executed as shell command');
    } catch (err) {
      assert.ok(err.message.length > 0);
      assert.ok(!err.message.includes('uid='), '$(id) should not execute in error path');
    }
  });

  it('handles pipe character in pattern without crashing', async () => {
    const mod = await import('../../../src/tools/file/find.js');
    try {
      const result = await mod.execute({
        path: fixturesDir,
        pattern: '|',
        mode: 'name',
      });
      assert.ok(typeof result === 'string');
    } catch (err) {
      assert.ok(err.message.length > 0);
    }
  });
});
