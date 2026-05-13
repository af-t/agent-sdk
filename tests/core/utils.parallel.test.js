import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupToolCalls } from '../../src/core/utils.js';

function fakeRegistry(flagsByName) {
  return { isParallelSafe: (name) => flagsByName[name] ?? false };
}

describe('groupToolCalls', () => {
  it('returns empty array for empty input', () => {
    const groups = groupToolCalls([], fakeRegistry({}));
    assert.deepEqual(groups, []);
  });

  it('single safe tool produces single group of size 1', () => {
    const tc = [{ id: 'a', function: { name: 'R' } }];
    const groups = groupToolCalls(tc, fakeRegistry({ R: true }));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 1);
    assert.equal(groups[0][0].id, 'a');
  });

  it('two safe tools collapse into one group', () => {
    const tc = [
      { id: 'a', function: { name: 'R' } },
      { id: 'b', function: { name: 'R' } },
    ];
    const groups = groupToolCalls(tc, fakeRegistry({ R: true }));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
  });

  it('all unsafe tools produce N groups of size 1', () => {
    const tc = [
      { id: 'a', function: { name: 'W' } },
      { id: 'b', function: { name: 'W' } },
      { id: 'c', function: { name: 'W' } },
    ];
    const groups = groupToolCalls(tc, fakeRegistry({ W: false }));
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups.map((g) => g.length),
      [1, 1, 1],
    );
  });

  it('mixed [safe, safe, unsafe, safe] produces three groups [2, 1, 1]', () => {
    const tc = [
      { id: 'a', function: { name: 'R' } },
      { id: 'b', function: { name: 'R' } },
      { id: 'c', function: { name: 'W' } },
      { id: 'd', function: { name: 'R' } },
    ];
    const groups = groupToolCalls(tc, fakeRegistry({ R: true, W: false }));
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups.map((g) => g.length),
      [2, 1, 1],
    );
    assert.equal(groups[0][0].id, 'a');
    assert.equal(groups[0][1].id, 'b');
    assert.equal(groups[1][0].id, 'c');
    assert.equal(groups[2][0].id, 'd');
  });

  it('preserves original tool_call references', () => {
    const original = [
      { id: 'x', function: { name: 'R' } },
      { id: 'y', function: { name: 'W' } },
    ];
    const groups = groupToolCalls(original, fakeRegistry({ R: true, W: false }));
    assert.strictEqual(groups[0][0], original[0]);
    assert.strictEqual(groups[1][0], original[1]);
  });
});
