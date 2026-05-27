import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import createAgent from '../../src/index.js';
import { execute as bashExecute } from '../../src/tools/system/bash.js';

test('Bash background:true returns immediately with job id and log path', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  const out = await bashExecute({ command: 'echo hello; sleep 0.5; echo done', background: true }, { agent });
  assert.match(out, /Started in background/);
  assert.match(out, /Job ID: bg-/);
  const m = out.match(/Log: (\S+)/);
  assert.ok(m, 'log path printed');
  const logPath = m[1];

  // Job is registered.
  const ids = [...agent.backgroundJobs.keys()];
  assert.equal(ids.length, 1);
  const job = agent.backgroundJobs.get(ids[0]);
  assert.equal(job.kind, 'bash');
  assert.equal(job.status, 'running');

  // Wait for child to finish.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(agent.backgroundJobs.get(ids[0]).status, 'exited');
  const content = fs.readFileSync(logPath, 'utf8');
  assert.match(content, /hello[\s\S]*done/);
});
