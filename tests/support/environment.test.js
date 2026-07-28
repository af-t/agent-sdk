import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { removeSecrets, sanitizeChildEnvironment } from '../../src/support/environment.js';

describe('removeSecrets', () => {
  it('removes API keys while preserving ordinary values', () => {
    assert.deepEqual(removeSecrets({ OPENROUTER_API_KEY: 'secret123', PATH: '/usr/bin' }), { PATH: '/usr/bin' });
  });

  it('removes tokens, passwords, and case-insensitive secret names', () => {
    assert.deepEqual(removeSecrets({ GITHUB_TOKEN: 'token', DB_PASSWORD: 'pass', MySecretKey: 'xyz', USER: 'admin' }), {
      USER: 'admin',
    });
  });

  it('does not mutate the caller environment', () => {
    const environment = { API_KEY: '123' };
    assert.deepEqual(removeSecrets(environment), {});
    assert.equal(environment.API_KEY, '123');
  });

  it('returns an empty object for an empty environment', () => {
    assert.deepEqual(removeSecrets({}), {});
  });
});

describe('sanitizeChildEnvironment', () => {
  it('removes secrets and runtime loader variables', () => {
    assert.deepEqual(
      sanitizeChildEnvironment({
        PATH: '/usr/bin',
        OPENROUTER_API_KEY: 'secret',
        NODE_OPTIONS: '--require bad.js',
        LD_PRELOAD: 'bad.so',
        PYTHONPATH: '/malicious',
      }),
      { PATH: '/usr/bin' },
    );
  });

  it('removes shell-function exports without changing the original object', () => {
    const environment = { PATH: '/usr/bin', 'BASH_FUNC_evil%%': '() { :; }', HOME: '/tmp/home' };
    assert.deepEqual(sanitizeChildEnvironment(environment), { PATH: '/usr/bin', HOME: '/tmp/home' });
    assert.equal(environment['BASH_FUNC_evil%%'], '() { :; }');
  });
});
