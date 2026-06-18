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

  it('rejects fast with an aborted flag when the caller signal is aborted (no retries)', async () => {
    const original = global.fetch;
    let calls = 0;
    global.fetch = async (_url, opts) => {
      calls++;
      if (opts.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      return { ok: true, status: 200, text: async () => '{"data":[]}' };
    };
    const ac = new AbortController();
    ac.abort();
    try {
      await assert.rejects(
        () => embedTexts(['a'], { apiKey: 'sk-x', baseUrl: 'https://x', model: 'm', signal: ac.signal }),
        (err) => err.aborted === true,
      );
      assert.equal(calls, 1); // withRetry must not retry a caller abort
    } finally {
      global.fetch = original;
    }
  });

  it('aligns vectors by index and fills missing ones with null', async () => {
    const original = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      // index 1 omitted entirely; 0 and 2 returned out of order
      text: async () =>
        JSON.stringify({
          data: [
            { index: 2, embedding: [2, 2] },
            { index: 0, embedding: [0, 0] },
          ],
          usage: { total_tokens: 5 },
        }),
    });
    try {
      const { vectors } = await embedTexts(['a', 'b', 'c'], { apiKey: 'sk-x', baseUrl: 'https://x', model: 'm' });
      assert.deepEqual(vectors, [[0, 0], null, [2, 2]]);
    } finally {
      global.fetch = original;
    }
  });

  it('omits OpenRouter headers for a non-openrouter base url', async () => {
    const original = global.fetch;
    let capturedHeaders;
    global.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ index: 0, embedding: [1] }], usage: {} }),
      };
    };
    try {
      await embedTexts(['a'], { apiKey: 'sk-x', baseUrl: 'https://api.openai.com/v1', model: 'm' });
      assert.equal(capturedHeaders.Authorization, 'Bearer sk-x');
      assert.equal(capturedHeaders['HTTP-Referer'], undefined);
      assert.equal(capturedHeaders['X-OpenRouter-Title'], undefined);
    } finally {
      global.fetch = original;
    }
  });

  it('includes OpenRouter headers for an openrouter base url', async () => {
    const original = global.fetch;
    let capturedHeaders;
    global.fetch = async (_url, opts) => {
      capturedHeaders = opts.headers;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ index: 0, embedding: [1] }], usage: {} }),
      };
    };
    try {
      await embedTexts(['a'], { apiKey: 'sk-x', baseUrl: 'https://openrouter.ai/api/v1', model: 'm' });
      assert.equal(capturedHeaders['HTTP-Referer'], 'https://github.com/af-t/agent-sdk');
      assert.equal(capturedHeaders['X-OpenRouter-Title'], 'OpenRouter CLI Agent');
    } finally {
      global.fetch = original;
    }
  });
});
