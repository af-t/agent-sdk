import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';

test('subscribe registers a persistent listener and returns a disposer', async () => {
  const agent = new Agent({ apiKey: 'x', model: 'm' });
  const seen = [];
  const dispose = agent.subscribe((e) => seen.push(e));

  // drive one terminal turn with no network
  agent._sendForTest = async () => ({ choices: [{ message: { content: 'done', tool_calls: undefined } }] });
  await agent.run('hi');

  assert.ok(seen.length > 0, 'listener should receive at least one event');
  dispose();
  const countAfter = seen.length;
  await agent.run('again');
  assert.equal(seen.length, countAfter, 'disposed listener receives nothing');
});

test('subscribe throws on non-function', () => {
  const agent = new Agent({ apiKey: 'x', model: 'm' });
  assert.throws(() => agent.subscribe(123), TypeError);
});

test('run loop broadcasts turn_end with terminal flag', async () => {
  const agent = new Agent({ apiKey: 'x', model: 'm' });
  const ends = [];
  agent.subscribe((e) => {
    if (e.turn_end) ends.push(e.turn_end);
  });
  agent._sendForTest = async () => ({ choices: [{ message: { content: 'done' } }] });
  await agent.run('hi');

  assert.equal(ends.length, 1);
  assert.equal(ends[0].turn, 1);
  assert.equal(ends[0].terminal, true);
});
