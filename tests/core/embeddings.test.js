import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, embedTexts } from '../../src/core/embeddings.js';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });

  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it('returns 0 on length mismatch or zero vector', () => {
    assert.equal(cosineSimilarity([1, 0], [1]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe('embedTexts', () => {
  it('posts to /embeddings and returns vectors sorted by index plus usage', async () => {
    const original = global.fetch;
    let capturedUrl;
    let capturedBody;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      // return data deliberately out of order to prove sorting
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
            usage: { total_tokens: 12 },
          }),
      };
    };
    try {
      const { vectors, usage } = await embedTexts(['a', 'b'], {
        apiKey: 'sk-x',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/text-embedding-3-small',
      });
      assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/embeddings');
      assert.deepEqual(capturedBody, { model: 'openai/text-embedding-3-small', input: ['a', 'b'] });
      assert.deepEqual(vectors, [
        [1, 0],
        [0, 1],
      ]);
      assert.equal(usage.total_tokens, 12);
    } finally {
      global.fetch = original;
    }
  });

  it('returns empty result without calling fetch for empty input', async () => {
    const original = global.fetch;
    let called = false;
    global.fetch = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    try {
      const out = await embedTexts([], { apiKey: 'sk-x', baseUrl: 'https://x', model: 'm' });
      assert.deepEqual(out, { vectors: [], usage: null });
      assert.equal(called, false);
    } finally {
      global.fetch = original;
    }
  });

  it('throws a non-retryable ApiError on HTTP 400', async () => {
    const original = global.fetch;
    global.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'bad model' } }),
    });
    try {
      await assert.rejects(
        () => embedTexts(['a'], { apiKey: 'sk-x', baseUrl: 'https://x', model: 'm' }),
        (err) => err.status === 400 && /bad model/.test(err.message),
      );
    } finally {
      global.fetch = original;
    }
  });
});
