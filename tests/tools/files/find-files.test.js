import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FIXTURES = path.resolve('tests/fixtures/find-test-dir');

describe('findFiles execute', () => {
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
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({
      path: FIXTURES,
      pattern: 'alpha',
      mode: 'name',
    });
    assert.ok(result.includes('alpha.txt'));
    assert.ok(!result.includes('beta'));
  });

  it('finds files by content pattern (mode=content)', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({
      path: FIXTURES,
      pattern: 'hello',
      mode: 'content',
    });
    assert.ok(result.includes('alpha.txt'));
    assert.ok(result.includes('gamma.txt'));
  });

  it('returns "No matches found" when nothing matches (name mode)', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({
      path: FIXTURES,
      pattern: 'zzznonexistent',
      mode: 'name',
    });
    assert.strictEqual(result, 'No matches found.');
  });

  it('returns "No matches found" when nothing matches (content mode)', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({
      path: FIXTURES,
      pattern: 'zzznonexistent',
      mode: 'content',
    });
    assert.strictEqual(result, 'No matches found.');
  });

  it('finds by name using regex patterns', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({
      path: FIXTURES,
      pattern: '\\.txt$',
      mode: 'name',
    });
    assert.ok(result.includes('alpha.txt'));
    assert.ok(result.includes('gamma.txt'));
    assert.ok(!result.includes('beta.md'));
  });
});

describe('findFiles: injection resistance', () => {
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    // The file name contains a command-substitution expression as literal text.
    await fs.writeFile(path.join(fixturesDir, 'cmd-$(id)-test.txt'), 'content', 'utf8');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    await fs.writeFile(path.join(fixturesDir, 'content-test.txt'), 'this file contains $(id) as literal text', 'utf8');
    try {
      const result = await mod.findFiles.execute({
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
    const mod = await import('../../../src/tools/files/find-files.js');
    try {
      const result = await mod.findFiles.execute({
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

describe('findFiles: abort signal handling', () => {
  const FIXTURES_ABORT = path.resolve('tests/fixtures/find-abort-dir');

  before(async () => {
    await fs.mkdir(path.join(FIXTURES_ABORT, 'sub'), { recursive: true });
    await fs.writeFile(path.join(FIXTURES_ABORT, 'a.txt'), 'hello', 'utf8');
    await fs.writeFile(path.join(FIXTURES_ABORT, 'sub', 'b.txt'), 'world', 'utf8');
  });

  after(async () => {
    await fs.rm(FIXTURES_ABORT, { recursive: true, force: true });
  });

  it('rejects immediately when ctx.signal is pre-aborted (mode=name)', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => mod.findFiles.execute({ path: FIXTURES_ABORT, pattern: '.', mode: 'name' }, { signal: ac.signal }),
      /File search was aborted before it started/,
    );
  });

  it('rejects immediately when ctx.signal is pre-aborted (mode=content)', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      () => mod.findFiles.execute({ path: FIXTURES_ABORT, pattern: 'hello', mode: 'content' }, { signal: ac.signal }),
      /File search was aborted before it started/,
    );
  });

  it('runs normally when no ctx is provided', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({ path: FIXTURES_ABORT, pattern: 'a\\.txt', mode: 'name' });
    assert.ok(typeof result === 'string');
  });

  it('runs normally when no ctx is provided (content mode)', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({ path: FIXTURES_ABORT, pattern: 'world', mode: 'content' });
    assert.ok(typeof result === 'string');
  });
});

describe('findFiles: child process environment', () => {
  it('removes secrets and startup injection variables from helper commands', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'find-files-env-'));
    const auditPath = path.join(temporaryDirectory, 'environment.txt');
    const whichPath = path.join(temporaryDirectory, 'which');
    const original = {
      PATH: process.env.PATH,
      FIND_FILES_AUDIT_PATH: process.env.FIND_FILES_AUDIT_PATH,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      NODE_PATH: process.env.NODE_PATH,
    };

    try {
      await fs.writeFile(whichPath, '#!/bin/sh\n/usr/bin/env > "$FIND_FILES_AUDIT_PATH"\nexit 1\n', 'utf8');
      await fs.chmod(whichPath, 0o755);
      process.env.PATH = `${temporaryDirectory}:${original.PATH}`;
      process.env.FIND_FILES_AUDIT_PATH = auditPath;
      process.env.OPENROUTER_API_KEY = 'find-files-secret';
      process.env.NODE_PATH = '/tmp/find-files-injected-modules';

      const mod = await import('../../../src/tools/files/find-files.js');
      await mod.findFiles.execute({ path: FIXTURES, pattern: 'alpha', mode: 'name' });

      const helperEnvironment = await fs.readFile(auditPath, 'utf8');
      assert.doesNotMatch(helperEnvironment, /OPENROUTER_API_KEY|find-files-secret/);
      assert.doesNotMatch(helperEnvironment, /NODE_PATH|find-files-injected-modules/);
      assert.match(
        helperEnvironment,
        new RegExp(`^PATH=${temporaryDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm'),
      );
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

describe('findFiles: nativeSearch fallback & edge cases', () => {
  const FIXTURES_NATIVE = path.resolve('tests/fixtures/find-native-dir');

  before(async () => {
    await fs.rm(FIXTURES_NATIVE, { recursive: true, force: true });
    await fs.mkdir(path.join(FIXTURES_NATIVE, 'deep'), { recursive: true });
    await fs.writeFile(path.join(FIXTURES_NATIVE, 'report.pdf'), 'some pdf content', 'utf8');
    await fs.writeFile(path.join(FIXTURES_NATIVE, 'deep', 'notes.txt'), 'important notes here', 'utf8');
    // Null bytes mark this fixture as binary.
    const buf = Buffer.alloc(600);
    buf[0] = 0x00; // null byte early
    buf.write('hello', 200);
    await fs.writeFile(path.join(FIXTURES_NATIVE, 'binary.bin'), buf);
  });

  after(async () => {
    await fs.rm(FIXTURES_NATIVE, { recursive: true, force: true });
  });

  it('throws on invalid regex pattern', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    await assert.rejects(
      () => mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: '[invalid', mode: 'name' }),
      /Invalid regex pattern/,
    );
  });

  it('skips binary files with null bytes in nativeSearch content mode', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    // Binary data contains "hello" but begins with null bytes, so the search skips it.
    // notes.txt contains "notes" without null bytes, so the search includes it.
    const result = await mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: 'notes', mode: 'content' });
    assert.ok(result.includes('notes.txt'), 'should find text file with matching content');
    assert.ok(!result.includes('binary.bin'), 'should skip binary file with null bytes');
  });

  it('skips binary files with high non-printable chars in nativeSearch', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const badBuf = Buffer.alloc(200);
    for (let i = 0; i < 150; i++) badBuf[i] = 0x02;
    badBuf.write('secret', 160);
    await fs.writeFile(path.join(FIXTURES_NATIVE, 'junk.bin'), badBuf);

    const result = await mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: 'secret', mode: 'content' });
    assert.ok(!result.includes('junk.bin'), 'should skip binary file with high non-printable ratio');
  });

  it('handles unreadable directory entries gracefully in nativeSearch', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const restrictedDir = path.join(FIXTURES_NATIVE, 'restricted');
    await fs.mkdir(restrictedDir, { recursive: true });
    await fs.writeFile(path.join(restrictedDir, 'secret.txt'), 'hidden content', 'utf8');
    try {
      await fs.chmod(restrictedDir, 0o000);
    } catch {
      // Platforms without restrictive permissions skip this assertion.
    }

    const result = await mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: 'notes', mode: 'content' });
    assert.ok(typeof result === 'string');

    try {
      await fs.chmod(restrictedDir, 0o755);
    } catch {}
  });

  it('handles search in subdirectory with relative path prefix', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const result = await mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: 'notes', mode: 'name' });
    assert.ok(result.includes('notes.txt'));
  });

  it('lists matching file with line number and snippet in content mode', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    await fs.writeFile(
      path.join(FIXTURES_NATIVE, 'multi-line.txt'),
      'line one\nline two\nmatch-this-word\nline four',
      'utf8',
    );

    const result = await mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: 'match-this-word', mode: 'content' });
    assert.ok(result.includes('multi-line.txt'), 'should mention the filename');
    assert.ok(result.includes(':3:'), 'should reference line 3');
  });

  it('handles abort mid-flight in nativeSearch', async () => {
    const mod = await import('../../../src/tools/files/find-files.js');
    const ac = new AbortController();
    // A large directory keeps the walk active long enough to observe cancellation.
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(path.join(FIXTURES_NATIVE, `many-${i}.txt`), `content ${i}`, 'utf8');
    }
    setTimeout(() => ac.abort(), 0);

    await assert.rejects(
      () =>
        mod.findFiles.execute({ path: FIXTURES_NATIVE, pattern: 'content', mode: 'content' }, { signal: ac.signal }),
      /File search was aborted/,
    );
  });
});
