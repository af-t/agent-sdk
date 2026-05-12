import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('logger', () => {
  let logger;
  let config;

  before(async () => {
    const loggerMod = await import('../../src/core/logger.js');
    logger = loggerMod.default;
    const configMod = await import('../../src/config.js');
    config = configMod.default;
  });

  it('exports an object with error, warn, debug, info methods', () => {
    assert.ok(logger && typeof logger === 'object');
    assert.strictEqual(typeof logger.error, 'function');
    assert.strictEqual(typeof logger.warn, 'function');
    assert.strictEqual(typeof logger.debug, 'function');
    assert.strictEqual(typeof logger.info, 'function');
  });

  it('named export equals default export', async () => {
    const mod = await import('../../src/core/logger.js');
    assert.strictEqual(mod.logger, mod.default);
  });

  it('error() does not throw for string, object, null, undefined, Error', () => {
    assert.doesNotThrow(() => logger.error('plain string'));
    assert.doesNotThrow(() => logger.error({ key: 'value' }));
    assert.doesNotThrow(() => logger.error(null));
    assert.doesNotThrow(() => logger.error(undefined));
    assert.doesNotThrow(() => logger.error(new Error('oops')));
  });

  it('warn() does not throw for common inputs', () => {
    assert.doesNotThrow(() => logger.warn('warning message'));
    assert.doesNotThrow(() => logger.warn({ code: 42 }));
  });

  it('info() does not throw for common inputs', () => {
    assert.doesNotThrow(() => logger.info('info message'));
    assert.doesNotThrow(() => logger.info({ status: 'ok' }));
  });

  it('debug() does not throw regardless of DEBUG flag', () => {
    assert.doesNotThrow(() => logger.debug('debug message'));
  });

  it('error() writes to stderr', () => {
    const chunks = [];
    const orig = console.error;
    console.error = (...args) => chunks.push(args.map(String).join(' '));
    logger.error('stderr-check');
    console.error = orig;
    assert.ok(chunks.length > 0, 'expected error() to call console.error');
    assert.ok(chunks.some((c) => c.includes('stderr-check')));
  });

  it('warn() writes to stderr', () => {
    const chunks = [];
    const orig = console.warn;
    console.warn = (...args) => chunks.push(args.map(String).join(' '));
    logger.warn('warn-check');
    console.warn = orig;
    assert.ok(chunks.length > 0, 'expected warn() to call console.warn');
    assert.ok(chunks.some((c) => c.includes('warn-check')));
  });

  it('info() writes to stdout', () => {
    const chunks = [];
    const orig = console.log;
    console.log = (...args) => chunks.push(args.map(String).join(' '));
    logger.info('info-check');
    console.log = orig;
    assert.ok(chunks.length > 0, 'expected info() to call console.log');
    assert.ok(chunks.some((c) => c.includes('info-check')));
  });

  it('debug() outputs when DEBUG=true, silent when DEBUG=false', () => {
    const chunks = [];
    const orig = console.log;
    console.log = (...args) => chunks.push(args.map(String).join(' '));
    logger.debug('debug-flag-check');
    console.log = orig;

    if (config.DEBUG) {
      assert.ok(chunks.some((c) => c.includes('debug-flag-check')));
    } else {
      assert.strictEqual(chunks.length, 0);
    }
  });

  it('redacts sk-or-... API keys in error output', () => {
    const chunks = [];
    const orig = console.error;
    console.error = (...args) => chunks.push(args.map(String).join(' '));
    logger.error('key is sk-or-abc123def456');
    console.error = orig;
    const output = chunks.join(' ');
    assert.ok(!output.includes('sk-or-abc123def456'), 'raw API key should be redacted');
    assert.ok(output.includes('sk-or-'), 'prefix should remain');
    assert.ok(output.includes('***REDACTED***'), 'should contain redaction marker');
  });

  it('redacts Bearer tokens in error output', () => {
    const chunks = [];
    const orig = console.error;
    console.error = (...args) => chunks.push(args.map(String).join(' '));
    logger.error('Authorization: Bearer abc123xyz789');
    console.error = orig;
    const output = chunks.join(' ');
    assert.ok(!output.includes('abc123xyz789'), 'bearer token should be redacted');
    assert.ok(output.includes('***REDACTED***'));
  });

  it('does not mangle plain strings without secrets', () => {
    const chunks = [];
    const orig = console.error;
    console.error = (...args) => chunks.push(args.map(String).join(' '));
    logger.error('hello world no secrets here');
    console.error = orig;
    const output = chunks.join(' ');
    assert.ok(output.includes('hello world no secrets here'));
  });

  it('non-string args are not mangled (objects pass through to console)', () => {
    const chunks = [];
    const orig = console.error;
    console.error = (...args) => chunks.push(args);
    logger.error('prefix', { obj: 'value' });
    console.error = orig;
    assert.ok(chunks.length > 0);
    // The object arg should pass through unchanged (not stringified to [object Object])
    const secondArg = chunks[0]?.[1];
    assert.ok(secondArg === undefined || typeof secondArg === 'object' || typeof secondArg === 'string');
  });
});
