import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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
