import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import createAgent from '../../src/index.js';
import { execute as bashExecute } from '../../src/tools/system/bash.js';

test('Bash on_timeout=background detaches instead of killing', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  try {
    const out = await bashExecute(
      { command: 'echo start; sleep 5; echo done', timeout: 200, on_timeout: 'background' },
      { agent },
    );
    assert.match(out, /exceeded timeout/);
    assert.match(out, /transitioned to background/);
    assert.match(out, /Job ID: bg-/);
    const m = out.match(/Log: (\S+)/);
    const logPath = m[1];

    // Process is still alive.
    const ids = [...agent.backgroundJobs.keys()];
    assert.equal(ids.length, 1);
    const job = agent.backgroundJobs.get(ids[0]);
    assert.equal(job.status, 'running');
    assert.equal(job.reason, 'timeout');

    // Wait for completion.
    await new Promise((r) => setTimeout(r, 5500));
    const finalJob = agent.backgroundJobs.get(ids[0]);
    assert.equal(finalJob.status, 'exited');
    const content = fs.readFileSync(logPath, 'utf8');
    assert.match(content, /start[\s\S]*done/);
  } finally {
    await agent.cleanup();
  }
});

test('Bash on_timeout=kill preserves legacy timeout behavior', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  try {
    await assert.rejects(
      bashExecute({ command: 'sleep 5', timeout: 200, on_timeout: 'kill' }, { agent }),
      /timed out/i,
    );
  } finally {
    await agent.cleanup();
  }
});

test('Bash background:true returns immediately with job id and log path', async () => {
  const agent = await createAgent({ apiKey: 'x' });
  try {
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
  } finally {
    await agent.cleanup();
  }
});
