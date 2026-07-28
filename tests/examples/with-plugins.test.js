import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestTempDir } from '../support/temp.js';

test('with-plugins can be imported without credentials or network access', () => {
  const exampleUrl = pathToFileURL(path.resolve('examples/with-plugins.js')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "globalThis.fetch = () => { throw new Error('network access during import'); }; const module = await import(process.argv[1]); if (typeof module.main !== 'function') throw new Error('main export is missing');",
      exampleUrl,
    ],
    { cwd: path.resolve('.'), encoding: 'utf8', env: { PATH: process.env.PATH } },
  );

  assert.equal(result.status, 0, result.stderr);
});

test('with-plugins runs when invoked through a relative symlink', (t) => {
  const dir = createTestTempDir(t, 'with-plugins-link-');
  const link = path.join(dir, 'with-plugins.js');
  try {
    fs.symlinkSync(path.resolve('examples/with-plugins.js'), link);
  } catch (error) {
    if (['EPERM', 'EOPNOTSUPP', 'ENOSYS'].includes(error.code)) {
      t.skip(`symlinks are unsupported: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = spawnSync(process.execPath, [path.relative(process.cwd(), link)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });

  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /OPENROUTER_API_KEY is required/);
});
