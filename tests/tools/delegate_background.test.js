import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';

test('Delegate-spawned subagent inherits parent.restricted', async () => {
  const parent = await createAgent({ apiKey: 'x', restricted: false });
  parent._sendForTest = async () => ({
    choices: [{ message: { content: 'subagent report', reasoning: null, tool_calls: null } }],
    usage: { cost: 0, total_tokens: 0 },
  });

  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  const out = await delegateExecute(
    { agent: 'researcher', prompt: 'test', description: 'test delegation' },
    { agent: parent, signal: new AbortController().signal },
  );
  assert.match(out, /Subagent ID:/);
  const child = [...parent.subagents.values()][0];
  assert.equal(child.restricted, false);
});

test('Delegate-spawned subagent shares parent storagePaths.tmpDir', async () => {
  const parent = await createAgent({
    apiKey: 'x',
    storagePaths: { tmpDir: '/tmp/openrouter-parent-test' },
  });
  parent._sendForTest = async () => ({
    choices: [{ message: { content: 'r', reasoning: null, tool_calls: null } }],
    usage: { cost: 0, total_tokens: 0 },
  });
  const { execute: delegateExecute } = await import('../../src/tools/system/delegate.js');
  await delegateExecute(
    { agent: 'researcher', prompt: 'test', description: 'test delegation' },
    { agent: parent, signal: new AbortController().signal },
  );
  const child = [...parent.subagents.values()][0];
  assert.equal(child._storagePaths?.tmpDir, '/tmp/openrouter-parent-test');
});
