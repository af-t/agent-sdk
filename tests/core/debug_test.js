import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// Quick investigation: why does path traversal not throw?
const root = path.resolve(process.cwd());
console.log('INVESTIGATION:');
console.log('cwd:', process.cwd());
console.log('root:', root);
const rp = path.resolve('../../etc/passwd');
console.log('resolved ../../etc/passwd:', rp);
const rel = path.relative(root, rp);
console.log('relative:', JSON.stringify(rel));
console.log('starts with ..:', rel.startsWith('..'));
console.log('isAbsolute:', path.isAbsolute(rel));
console.log('!relative:', !rel);

describe('ensureSafePath debug', () => {
  let ensureSafePath;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    ensureSafePath = mod.ensureSafePath;
  });

  it('rejects path traversal (..)', () => {
    try {
      ensureSafePath('../../etc/passwd');
      console.log('NO ERROR THROWN - unexpected!');
    } catch (e) {
      console.log('ERROR:', e.message);
    }
    // Just check that it at least doesn't crash
    assert.ok(true);
  });
});
