import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashContent, isRangeCovered, mergeRanges } from '../../src/core/file-state.js';

describe('hashContent', () => {
  it('returns stable hex digest for the same input', () => {
    const a = hashContent('hello world');
    const b = hashContent('hello world');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('returns different digests for different inputs', () => {
    assert.notEqual(hashContent('a'), hashContent('b'));
  });

  it('hashes empty content deterministically', () => {
    const a = hashContent('');
    const b = hashContent('');
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});

describe('isRangeCovered', () => {
  it('returns true for a strict subset', () => {
    assert.equal(isRangeCovered([[1, 10]], 3, 7), true);
  });

  it('returns true for an exact match', () => {
    assert.equal(isRangeCovered([[1, 10]], 1, 10), true);
  });

  it('returns false when the range exceeds any covered span', () => {
    assert.equal(isRangeCovered([[1, 5]], 1, 10), false);
  });

  it('returns false on empty ranges', () => {
    assert.equal(isRangeCovered([], 1, 5), false);
  });

  it('returns true when one of several spans covers the query', () => {
    assert.equal(
      isRangeCovered(
        [
          [1, 3],
          [10, 20],
        ],
        12,
        15,
      ),
      true,
    );
  });

  it('returns false when query spans across two disjoint covered ranges', () => {
    assert.equal(
      isRangeCovered(
        [
          [1, 5],
          [10, 20],
        ],
        4,
        12,
      ),
      false,
    );
  });
});

describe('mergeRanges', () => {
  it('merges adjacent ranges (touching end+1 == nextStart)', () => {
    assert.deepEqual(
      mergeRanges([
        [5, 10],
        [1, 4],
      ]),
      [[1, 10]],
    );
  });

  it('merges overlapping ranges', () => {
    assert.deepEqual(
      mergeRanges([
        [1, 3],
        [2, 5],
      ]),
      [[1, 5]],
    );
  });

  it('keeps disjoint ranges sorted and separate', () => {
    assert.deepEqual(
      mergeRanges([
        [1, 3],
        [7, 10],
      ]),
      [
        [1, 3],
        [7, 10],
      ],
    );
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(mergeRanges([]), []);
  });

  it('sorts unsorted input by start ascending', () => {
    assert.deepEqual(
      mergeRanges([
        [20, 25],
        [5, 8],
        [10, 15],
      ]),
      [
        [5, 8],
        [10, 15],
        [20, 25],
      ],
    );
  });

  it('merges chains of overlapping + adjacent ranges', () => {
    assert.deepEqual(
      mergeRanges([
        [1, 4],
        [5, 6],
        [6, 9],
      ]),
      [[1, 9]],
    );
  });
});
