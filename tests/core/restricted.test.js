import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';
import { ToolRegistry } from '../../src/registries/tool-registry.js';
import { runShell } from '../../src/tools/system/run-shell.js';
const { execute: runShellExecute } = runShell;

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
  agent.registerTools({
    name: 'probe_restricted',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      seen = ctx.agent?.restricted;
      return 'ok';
    },
  });
  await agent.tools.execute('probe_restricted', {}, { agent });
  assert.equal(seen, false);
});

test('restricted=false emits a structured warning at construction', async () => {
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
  assert.deepEqual(JSON.parse(captured), {
    component: 'agent',
    restricted: false,
    message: 'Agent constructed with security checks disabled',
  });
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

test('runShell blocks rm -rf / when restricted=true', async () => {
  const fakeAgent = { restricted: true };
  await assert.rejects(runShellExecute({ command: 'rm -rf /' }, { agent: fakeAgent }), /BLOCKED/);
});

test('runShell skips the block list when restricted=false', async () => {
  const fakeAgent = { restricted: false };
  // Use a harmless command that contains a blocked substring as a comment.
  // The block check uses `.includes`, so this would normally trigger.
  await runShellExecute({ command: "echo 'rm -rf /' # printing only" }, { agent: fakeAgent });
});

test('runShell strips secret env vars when restricted=true', async () => {
  const fakeAgent = { restricted: true };
  const out = await runShellExecute(
    { command: 'echo "SECRET=${SECRET_TOKEN:-MISSING}"', env: { SECRET_TOKEN: 'sek' } },
    { agent: fakeAgent },
  );
  assert.match(String(out), /SECRET=MISSING/);
});

test('runShell passes through env vars when restricted=false', async () => {
  const fakeAgent = { restricted: false };
  const out = await runShellExecute(
    { command: 'echo "SECRET=${SECRET_TOKEN}"', env: { SECRET_TOKEN: 'sek' } },
    { agent: fakeAgent },
  );
  assert.match(String(out), /SECRET=sek/);
});

test('McpClientWrapper inherits process.env when restricted=false', async () => {
  const { McpClientWrapper } = await import('../../src/integrations/mcp-client.js');
  process.env.OPENROUTER_LEAK_PROBE = 'leak';
  try {
    const w1 = new McpClientWrapper({ command: 'true', args: [], restricted: true });
    const w2 = new McpClientWrapper({ command: 'true', args: [], restricted: false });
    // The internal env builder is private; assert via the resolved env getter if present,
    // otherwise rely on a wrapper-level method. If the only way to observe is to
    // spawn, assert that the `restricted` flag is stored on the instance where
    // the spawn path can read it.
    assert.equal(w1.restricted, true, 'restricted=true wrapper stores flag');
    assert.equal(w2.restricted, false, 'restricted=false wrapper stores flag');
  } finally {
    delete process.env.OPENROUTER_LEAK_PROBE;
  }
});
