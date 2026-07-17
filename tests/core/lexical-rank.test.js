import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lexicalRank } from '../../src/core/lexical-rank.js';

describe('lexicalRank', () => {
  it('scores the document sharing query terms highest', () => {
    const docs = [
      'the user prefers gpg signed commits on every change',
      'a recipe for chocolate cake with flour and sugar',
    ];
    const scores = lexicalRank('gpg signing commits', docs);
    assert.equal(scores.length, 2);
    assert.ok(scores[0] > scores[1], `expected ${scores[0]} > ${scores[1]}`);
  });

  it('returns an empty array for an empty corpus', () => {
    assert.deepEqual(lexicalRank('anything', []), []);
  });

  it('returns 0 for a document with no shared terms', () => {
    const scores = lexicalRank('zzz qqq', ['alpha beta gamma']);
    assert.equal(scores[0], 0);
  });

  it('weights repeated query terms without changing document order', () => {
    const scores = lexicalRank('alpha alpha beta', ['alpha', 'beta', 'gamma']);
    assert.equal(scores.length, 3);
    assert.ok(scores[0] > scores[1]);
    assert.equal(scores[2], 0);
  });
});
