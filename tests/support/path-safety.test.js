import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';
import { clearIgnoreFilterCache, loadIgnoreFilter, resolveSafePath } from '../../src/support/path-safety.js';

const projectRoot = process.cwd();

describe('resolveSafePath', () => {
  it('resolves a valid relative path canonically', () => {
    assert.equal(resolveSafePath('src/index.js', new Set(), { restricted: true }), realpathSync('src/index.js'));
  });

  it('accepts a valid absolute path within the project', () => {
    assert.ok(resolveSafePath(path.resolve(projectRoot, 'src/index.js')));
  });

  it('accepts the project root itself', () => {
    assert.equal(path.resolve(resolveSafePath('.')), path.resolve(projectRoot));
  });

  it('rejects null bytes', () => {
    assert.throws(() => resolveSafePath('../../etc/passwd\0'), { message: /null byte/ });
  });

  it('rejects directory traversal', () => {
    assert.throws(() => resolveSafePath('../../etc/passwd'), { message: /directory traversal|outside project root/ });
  });

  it('rejects encoded traversal after repeated decoding', () => {
    for (const input of [
      '%2e%2e%2fetc%2fpasswd',
      '%252e%252e%252fetc%252fpasswd',
      'etc%252fpasswd',
      '..%5c..%5cetc%5cpasswd',
    ]) {
      assert.throws(() => resolveSafePath(input), { message: /URL-encoded traversal/ });
    }
  });

  it('handles very long paths without crashing', () => {
    try {
      resolveSafePath('a/'.repeat(2048) + 'file.txt');
    } catch (error) {
      assert.ok(error.message.length > 0);
    }
  });

  it('rejects a symlink that escapes the project root', () => {
    const symlinkPath = path.join(projectRoot, 'tests/fixtures/symlink-outside');
    let created = false;
    try {
      fs.symlinkSync('/data', symlinkPath);
      created = true;
      assert.throws(() => resolveSafePath('tests/fixtures/symlink-outside'), {
        message: /Access denied|outside project root/,
      });
    } catch (error) {
      if (created && !/Access denied|outside project root/.test(error.message)) throw error;
    } finally {
      if (created) fs.unlinkSync(symlinkPath);
    }
  });

  it('rejects protocol handlers', () => {
    assert.throws(() => resolveSafePath('file:///etc/passwd'), { message: /protocol handler/ });
    assert.throws(() => resolveSafePath('https://evil.com/payload'), { message: /protocol handler/ });
  });

  it('accepts paths under explicitly trusted external roots', () => {
    const externalDir = realpathSync(os.tmpdir());
    const externalFile = path.join(externalDir, 'test.txt');
    assert.ok(resolveSafePath(externalFile, new Set([externalDir])).startsWith(externalDir));
    assert.equal(resolveSafePath(externalDir, new Set([externalDir])), externalDir);
  });

  it('rejects a symlink inside a trusted root that escapes it', () => {
    const trustedDir = fs.mkdtempSync(path.join(realpathSync(os.tmpdir()), 'trusted-'));
    const symlinkPath = path.join(trustedDir, 'escape');
    try {
      fs.symlinkSync('/etc', symlinkPath);
      assert.throws(() => resolveSafePath(symlinkPath, new Set([trustedDir])), {
        message: /resolves outside trusted root/,
      });
    } finally {
      fs.rmSync(trustedDir, { recursive: true, force: true });
    }
  });

  it('rejects untrusted and relative external roots', () => {
    assert.throws(() => resolveSafePath('/etc/passwd', new Set()), { message: /outside project root/ });
    assert.throws(() => resolveSafePath('/etc/passwd', new Set([path.join(os.tmpdir(), 'other-trusted')])), {
      message: /outside project root/,
    });
    assert.throws(() => resolveSafePath('/etc/passwd', new Set(['relative/dir'])), { message: /outside project root/ });
  });

  it('still rejects null bytes when the path is under a trusted root', () => {
    const trustedRoot = realpathSync(os.tmpdir());
    assert.throws(() => resolveSafePath(path.join(trustedRoot, 'file\0.txt'), new Set([trustedRoot])), {
      message: /null byte/,
    });
  });

  it('defaults to restricted project containment', () => {
    assert.throws(() => resolveSafePath('/etc/passwd'), { message: /outside project root/ });
    assert.ok(resolveSafePath('src/index.js').endsWith('src/index.js'));
  });

  it('enforces null-byte, encoded traversal, and protocol rules when unrestricted', () => {
    assert.throws(() => resolveSafePath('foo\0bar', null, { restricted: false }), /null byte/i);
    assert.throws(() => resolveSafePath('a/%2e%2e/etc/passwd', null, { restricted: false }), /encoded|traversal/i);
    assert.throws(() => resolveSafePath('file:///etc/passwd', null, { restricted: false }), /protocol|file:/i);
  });

  it('permits canonical external paths when unrestricted', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'path-safety-'));
    const file = path.join(directory, 'a.txt');
    try {
      fs.writeFileSync(file, 'hi');
      assert.equal(resolveSafePath(file, null, { restricted: false }), fs.realpathSync(file));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('loadIgnoreFilter', () => {
  it('returns a cached filter with the ignore interface', async () => {
    clearIgnoreFilterCache();
    const first = await loadIgnoreFilter();
    const second = await loadIgnoreFilter();
    assert.equal(typeof first.test, 'function');
    assert.equal(typeof first.ignores, 'function');
    assert.equal(typeof first.add, 'function');
    assert.strictEqual(first, second);
  });
});
