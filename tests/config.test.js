import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Ensure a valid API key is present before config.js is imported
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'sk-test-config-key';

describe('config', () => {
  let config;
  let config2;

  before(async () => {
    const mod = await import('../src/config.js');
    config = mod.default;
    const mod2 = await import('../src/config.js');
    config2 = mod2.default;
  });

  it('exports expected keys', () => {
    for (const k of [
      'API_KEY',
      'ORDER',
      'ONLY',
      'MODEL',
      'MAX_TOKENS',
      'MAX_TURNS',
      'TAVILY_API_KEY',
      'MAX_RETRIES',
      'DEBUG',
      'TEMPERATURE',
      'TOP_P',
      'MIN_P',
      'TOP_K',
      'FREQUENCY_PENALTY',
      'PRESENCE_PENALTY',
      'REPETITION_PENALTY',
      'SEED',
      'MAX_COMPLETION_TOKENS',
      'REASONING_EFFORT',
      'REASONING_MAX_TOKENS',
      'REASONING_EXCLUDE',
      'REASONING_ENABLED',
      'PROVIDER_ALLOW_FALLBACKS',
      'PROVIDER_REQUIRE_PARAMETERS',
      'PROVIDER_DATA_COLLECTION',
      'PROVIDER_AVOID',
      'PROVIDER_SORT',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(config, k), `missing key: ${k}`);
    }
    assert.strictEqual(Object.keys(config).length, 27);
  });

  it('top-level object is frozen', () => {
    assert.ok(Object.isFrozen(config));
  });

  it('mutating a top-level key throws TypeError', () => {
    assert.throws(() => {
      config.MAX_RETRIES = 999;
    }, TypeError);
  });

  it('MAX_RETRIES is the number 5', () => {
    assert.strictEqual(typeof config.MAX_RETRIES, 'number');
    assert.strictEqual(config.MAX_RETRIES, 5);
  });

  it('DEBUG is a boolean', () => {
    assert.strictEqual(typeof config.DEBUG, 'boolean');
  });

  it('API_KEY is a non-empty string when env var is set', () => {
    assert.strictEqual(typeof config.API_KEY, 'string');
    assert.ok(config.API_KEY.length > 0, 'API_KEY should be non-empty');
  });

  it('MODEL is string or undefined', () => {
    assert.ok(config.MODEL === undefined || typeof config.MODEL === 'string');
  });

  it('MAX_TOKENS is string or undefined', () => {
    assert.ok(config.MAX_TOKENS === undefined || typeof config.MAX_TOKENS === 'string');
  });

  it('MAX_TURNS is string or undefined', () => {
    assert.ok(config.MAX_TURNS === undefined || typeof config.MAX_TURNS === 'string');
  });

  it('TAVILY_API_KEY is string or undefined', () => {
    assert.ok(config.TAVILY_API_KEY === undefined || typeof config.TAVILY_API_KEY === 'string');
  });

  it('ORDER is array or undefined', () => {
    assert.ok(config.ORDER === undefined || Array.isArray(config.ORDER));
  });

  it('ONLY is array or undefined', () => {
    assert.ok(config.ONLY === undefined || Array.isArray(config.ONLY));
  });

  it('deepFreeze: array values are also frozen', () => {
    if (Array.isArray(config.ORDER)) assert.ok(Object.isFrozen(config.ORDER), 'ORDER array should be frozen');
    if (Array.isArray(config.ONLY)) assert.ok(Object.isFrozen(config.ONLY), 'ONLY array should be frozen');
  });

  it('repeated imports return the same reference (singleton)', () => {
    assert.strictEqual(config, config2);
  });
});
