import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestHeaders, resolveApiDialect } from '../../src/support/http.js';

describe('resolveApiDialect', () => {
  it('recognizes OpenRouter URLs', () => {
    assert.equal(resolveApiDialect('https://openrouter.ai/api/v1'), 'openrouter');
    assert.equal(resolveApiDialect('https://gateway.openrouter.ai/api/v1'), 'openrouter');
  });

  it('defaults other and malformed URLs to OpenAI dialects', () => {
    assert.equal(resolveApiDialect('https://example.com/v1'), 'openai');
    assert.equal(resolveApiDialect('http://localhost:1234/v1'), 'openai');
    assert.equal(resolveApiDialect('not a url openrouter.ai'), 'openrouter');
    assert.equal(resolveApiDialect('garbage'), 'openai');
  });
});

describe('buildRequestHeaders', () => {
  it('adds OpenRouter attribution headers only for OpenRouter', () => {
    assert.deepEqual(buildRequestHeaders({ apiKey: 'sk-x', dialect: 'openrouter' }), {
      Authorization: 'Bearer sk-x',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/af-t/agent-sdk',
      'X-Title': 'OpenRouter CLI Agent',
      'X-OpenRouter-Title': 'OpenRouter CLI Agent',
    });
  });

  it('does not send OpenRouter headers to other dialects', () => {
    assert.deepEqual(buildRequestHeaders({ apiKey: 'sk-x', dialect: 'openai' }), {
      Authorization: 'Bearer sk-x',
      'Content-Type': 'application/json',
    });
  });
});
