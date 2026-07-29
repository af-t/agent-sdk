import { test } from 'node:test';
import assert from 'node:assert/strict';
import createAgent from '../../src/index.js';
import { createTestTempDir } from '../support/temp.js';

test('agent.backgroundJobs starts empty and keeps its jobs private', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  assert.deepEqual(agent.backgroundJobs.list(), []);
  assert.equal(agent.backgroundJobs.get('bg-anything'), undefined);
  // Jobs are registered through the collaborator, not by mutating a shared map.
  assert.equal(agent.backgroundJobs.set, undefined);
  assert.equal(typeof agent.backgroundJobs.register, 'function');
});

test('onBackgroundExit registers a listener and returns a disposer', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  let called = 0;
  const dispose = agent.onBackgroundExit(() => {
    called += 1;
  });
  assert.equal(typeof dispose, 'function');

  agent._fireBackgroundExit({ id: 'bg-test', kind: 'bash', exitCode: 0 });
  assert.equal(called, 1);

  dispose();
  agent._fireBackgroundExit({ id: 'bg-test', kind: 'bash', exitCode: 0 });
  assert.equal(called, 1, 'disposer should remove listener');
});

test('multiple listeners all fire on the same event', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  let a = 0;
  let b = 0;
  agent.onBackgroundExit(() => (a += 1));
  agent.onBackgroundExit(() => (b += 1));
  agent._fireBackgroundExit({ id: 'bg-x', kind: 'bash', exitCode: 0 });
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('onBackgroundExit throws on non-function', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  assert.throws(() => agent.onBackgroundExit('not a fn'), TypeError);
});
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

test('background log dir uses storagePaths.tmpDir when configured', async (t) => {
  const resource = { agent: undefined };
  t.after(() => resource.agent?.cleanup());
  const tmp = createTestTempDir(t, 'or-bg-');
  resource.agent = await createAgent({ apiKey: 'x', storagePaths: { tmpDir: tmp } });
  const { agent } = resource;
  const dir = agent._resolveBackgroundLogDir();
  assert.equal(dir, fs.realpathSync(tmp));
});

test('background log dir falls back to os.tmpdir/<appName>-<pid> when unconfigured', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  const dir = agent._resolveBackgroundLogDir();
  const expected = path.join(os.tmpdir(), `agent-sdk-${process.pid}`);
  assert.equal(dir, fs.realpathSync(expected));
  assert.ok(fs.existsSync(dir));
  assert.ok(agent.trustedPaths.has(dir));
});

test('cleanup removes the auto-created fallback log dir', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  const dir = agent._resolveBackgroundLogDir();
  assert.ok(fs.existsSync(dir));
  await agent.cleanup();
  assert.equal(fs.existsSync(dir), false, 'an agent that created its own log dir removes it again');
});

test('pending bg exits drain into messages as a system-reminder after tool group', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  agent.registerTools({
    name: 'noop',
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      // Simulate a bg exit happening during the tool call. While a loop is
      // active the event only queues, and the loop drains it at a tool boundary.
      agent._fireBackgroundExit({
        id: 'bg-xyz',
        kind: 'bash',
        exitCode: 0,
        durationMs: 123,
        logPath: path.join(os.tmpdir(), 'x.log'),
        status: 'exited',
      });
      return 'ok';
    },
  });

  let call = 0;
  agent._sendForTest = async () => {
    call += 1;
    if (call === 1) {
      return {
        choices: [
          {
            message: {
              content: '',
              reasoning: null,
              tool_calls: [{ id: 'a', function: { name: 'noop', arguments: '{}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      };
    }
    return {
      choices: [{ message: { content: 'final', reasoning: null, tool_calls: null } }],
      usage: { cost: 0, total_tokens: 0 },
    };
  };

  await agent.run('go');

  const drained = agent.messages.find((m) => m.role === 'user' && JSON.stringify(m.content).includes('bg-xyz'));
  assert.ok(drained, 'bg exit should drain into a user message');
  assert.match(JSON.stringify(drained.content), /system-reminder/);
});

import { spawn } from 'node:child_process';

test('cleanup() kills running background jobs', async (t) => {
  const agent = await createAgent({ apiKey: 'x' });
  t.after(() => agent.cleanup());
  const child = spawn('bash', ['-c', 'sleep 30']);
  agent.backgroundJobs.register({
    id: 'bg-test',
    kind: 'bash',
    child,
    status: 'running',
    startedAt: Date.now(),
  });
  assert.equal(child.killed, false);
  await agent.cleanup();
  // Allow event loop to process kill signal.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(child.killed || child.exitCode !== null, 'child should be killed after cleanup');
});
