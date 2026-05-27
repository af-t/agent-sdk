import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';
import { ToolRegistry } from '../../src/registry/tool.js';
import { execute as bashExecute } from '../../src/tools/system/bash.js';

test('agent.restricted defaults to true', async () => {
  const agent = await createAgent({ apiKey: 'sk-test' });
  assert.equal(agent.restricted, true);
});

test('agent.restricted respects constructor option', async () => {
  const agent = await createAgent({ apiKey: 'sk-test', restricted: false });
  assert.equal(agent.restricted, false);
});

test('ctx.agent.restricted is exposed to tools at execute time', async () => {
  const agent = await createAgent({ apiKey: 'sk-test', restricted: false });
  let seen;
  agent.use({
    name: 'probe_restricted',
    description: 'd',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      seen = ctx.agent?.restricted;
      return 'ok';
    },
  });
  await agent.tools.execute('probe_restricted', {}, { agent });
  assert.equal(seen, false);
});

test('restricted=false emits a warning at construction', async () => {
  const origWrite = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += chunk.toString();
    return true;
  };
  try {
    await createAgent({ apiKey: 'sk-test', restricted: false });
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

test('createAgent forwards restricted to its ToolRegistry', async () => {
  const a = await createAgent({ apiKey: 'sk-test', restricted: false });
  assert.equal(a.tools.restricted, false);
  const b = await createAgent({ apiKey: 'sk-test' });
  assert.equal(b.tools.restricted, true);
});

test('Bash blocks rm -rf / when restricted=true', async () => {
  const fakeAgent = { restricted: true };
  await assert.rejects(bashExecute({ command: 'rm -rf /' }, { agent: fakeAgent }), /BLOCKED/);
});

test('Bash skips block list when restricted=false', async () => {
  const fakeAgent = { restricted: false };
  // Use a harmless command that contains a blocked substring as a comment.
  // The block check uses `.includes`, so this would normally trigger.
  await bashExecute({ command: "echo 'rm -rf /' # printing only" }, { agent: fakeAgent });
});

test('Bash strips secret env vars when restricted=true', async () => {
  const fakeAgent = { restricted: true };
  const out = await bashExecute(
    { command: 'echo "SECRET=${SECRET_TOKEN:-MISSING}"', env: { SECRET_TOKEN: 'sek' } },
    { agent: fakeAgent },
  );
  assert.match(String(out), /SECRET=MISSING/);
});

test('Bash passes through env vars when restricted=false', async () => {
  const fakeAgent = { restricted: false };
  const out = await bashExecute(
    { command: 'echo "SECRET=${SECRET_TOKEN}"', env: { SECRET_TOKEN: 'sek' } },
    { agent: fakeAgent },
  );
  assert.match(String(out), /SECRET=sek/);
});
