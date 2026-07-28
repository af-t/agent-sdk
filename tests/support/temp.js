import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createTestTempDir(t, prefix) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix)) {
    throw new TypeError('prefix must be a safe temporary directory prefix');
  }
  const root = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, prefix));
  if (path.dirname(fs.realpathSync(dir)) !== root) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('temporary directory must be created below the configured temp root');
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
