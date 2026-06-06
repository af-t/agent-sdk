import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from '../../src/core/embeddings.js';

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
