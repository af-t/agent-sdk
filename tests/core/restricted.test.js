import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';
import { ToolRegistry } from '../../src/registry/tool.js';

test('agent.restricted defaults to true', () => {
  const agent = createAgent({ apiKey: 'sk-test' });
  assert.equal(agent.restricted, true);
});

test('agent.restricted respects constructor option', () => {
  const agent = createAgent({ apiKey: 'sk-test', restricted: false });
  assert.equal(agent.restricted, false);
});

test('ctx.agent.restricted is exposed to tools at execute time', async () => {
  const agent = createAgent({ apiKey: 'sk-test', restricted: false });
  let seen;
  agent.use({
    name: 'probe',
    description: 'd',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      seen = ctx.agent?.restricted;
      return 'ok';
    },
  });
  await agent.tools.execute('probe', {}, { agent });
  assert.equal(seen, false);
});

test('restricted=false emits a warning at construction', () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk.toString();
    return true;
  };
  try {
    createAgent({ apiKey: 'sk-test', restricted: false });
  } finally {
    process.stderr.write = origWrite;
  }
  assert.match(captured, /restricted=false/);
});

test('ToolRegistry stores restricted flag (default true)', () => {
  const r1 = new ToolRegistry();
  const r2 = new ToolRegistry({ restricted: true });
  const r3 = new ToolRegistry({ restricted: false });
  assert.equal(r1.restricted, true);
  assert.equal(r2.restricted, true);
  assert.equal(r3.restricted, false);
});

test('Agent forwards restricted to its ToolRegistry', () => {
  const a = createAgent({ apiKey: 'sk-test', restricted: false });
  assert.equal(a.tools.restricted, false);
  const b = createAgent({ apiKey: 'sk-test' });
  assert.equal(b.tools.restricted, true);
});
