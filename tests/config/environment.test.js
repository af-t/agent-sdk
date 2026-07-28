import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../../src/support/errors.js';
import { loadEnvironmentConfig } from '../../src/config/environment.js';

describe('loadEnvironmentConfig', () => {
  it('parses injected environment values into a frozen configuration object', () => {
    const config = loadEnvironmentConfig({
      OPENROUTER_API_KEY: 'test-key',
      OPENROUTER_BASE_URL: 'https://proxy.example/v1',
      OPENROUTER_MODEL: 'example/model',
      AGENT_SDK_APP_NAME: 'test-app',
      OPENROUTER_EMBEDDING_MODEL: 'example/embed',
      OPENROUTER_MAX_TURNS: '12',
      OPENROUTER_AUTO_WAKE: 'true',
      OPENROUTER_EMPTY_TURN_RECOVERY: '0',
      OPENROUTER_EMPTY_TURN_RETRIES: '3',
      TAVILY_API_KEY: 'tavily-key',
      DEBUG: '1',
      OPENROUTER_TEMPERATURE: '0.7',
      OPENROUTER_TOP_P: '0.9',
      OPENROUTER_MIN_P: '0.1',
      OPENROUTER_TOP_K: '42',
      OPENROUTER_FREQUENCY_PENALTY: '-0.2',
      OPENROUTER_PRESENCE_PENALTY: '0.3',
      OPENROUTER_REPETITION_PENALTY: '1.1',
      OPENROUTER_SEED: '123',
      OPENROUTER_MAX_COMPLETION_TOKENS: '2048',
      OPENROUTER_REASONING_EFFORT: 'high',
      OPENROUTER_REASONING_MAX_TOKENS: '1024',
      OPENROUTER_REASONING_EXCLUDE: 'false',
      OPENROUTER_REASONING_ENABLED: 'true',
      OPENROUTER_ORDER: 'OpenRouter, Google',
      OPENROUTER_ONLY: 'Google,Anthropic',
      OPENROUTER_PROVIDER_ALLOW_FALLBACKS: 'false',
      OPENROUTER_PROVIDER_REQUIRE_PARAMETERS: '1',
      OPENROUTER_PROVIDER_DATA_COLLECTION: 'deny',
      OPENROUTER_PROVIDER_IGNORE: 'Provider A, Provider B',
      OPENROUTER_PROVIDER_SORT: 'price',
    });

    assert.equal(config.apiKey, 'test-key');
    assert.equal(config.maxTurns, 12);
    assert.equal(config.autoWake, true);
    assert.equal(config.emptyTurnRecovery, false);
    assert.equal(config.emptyTurnRetries, 3);
    assert.equal(config.debug, true);
    assert.equal(config.temperature, 0.7);
    assert.equal(config.topK, 42);
    assert.equal(config.reasoning.maxTokens, 1024);
    assert.equal(config.reasoning.exclude, false);
    assert.deepEqual(config.provider.order, ['OpenRouter', 'Google']);
    assert.deepEqual(config.provider.only, ['Google', 'Anthropic']);
    assert.equal(config.provider.allowFallbacks, false);
    assert.equal(config.provider.requireParameters, true);
    assert.deepEqual(config.provider.avoid, ['Provider A', 'Provider B']);
    assert.deepEqual(
      Object.keys(config).sort(),
      [
        'apiKey',
        'appName',
        'autoWake',
        'baseUrl',
        'debug',
        'embeddingModel',
        'emptyTurnRecovery',
        'emptyTurnRetries',
        'frequencyPenalty',
        'maxCompletionTokens',
        'maxRetries',
        'maxTurns',
        'minP',
        'model',
        'presencePenalty',
        'provider',
        'reasoning',
        'repetitionPenalty',
        'seed',
        'tavilyApiKey',
        'temperature',
        'topK',
        'topP',
      ].sort(),
    );
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.provider));
    assert.ok(Object.isFrozen(config.reasoning));
  });

  it('uses the provider avoid alias when ignore is absent', () => {
    const config = loadEnvironmentConfig({ OPENROUTER_PROVIDER_AVOID: 'OpenAI, Anthropic' });

    assert.deepEqual(config.provider.avoid, ['OpenAI', 'Anthropic']);
  });

  it('rejects malformed numeric environment values', () => {
    assert.throws(
      () => loadEnvironmentConfig({ OPENROUTER_MAX_TURNS: 'twelve' }),
      (error) => error instanceof ConfigError && /OPENROUTER_MAX_TURNS/.test(error.message),
    );
  });
});
