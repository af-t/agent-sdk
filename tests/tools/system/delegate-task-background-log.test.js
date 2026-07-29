import { describe, it, before, after, mock } from 'node:test';
/* eslint-disable prefer-const */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestTempDir } from '../../support/temp.js';

// A failed background log write cannot crash the host process. The exit event
// still tells the parent that the job ended.
describe('delegateTask background: log write failure does not crash the host', () => {
  let Agent;
  let execute;

  before(async () => {
    Agent = (await import('../../../src/agent/agent.js')).default;
    execute = (await import('../../../src/tools/system/delegate-task.js')).delegateTask.execute;
  });

  after(() => {
    mock.restoreAll();
  });

  it('survives a failing background log write and still fires the exit event', async (t) => {
    let parent;
    t.after(() => parent?.cleanup());
    const tmpDir = createTestTempDir(t, 'delegate-background-');
    parent = new Agent({ apiKey: 'sk-test', storagePaths: { tmpDir } });
    // Subagents inherit _sendForTest, so the subagent loop makes no network call.
    parent._sendForTest = async () => ({
      choices: [{ message: { content: 'sub report done', reasoning: null, tool_calls: null }, finish_reason: 'stop' }],
      usage: { cost: 0, total_tokens: 3 },
    });

    // Make the background log write fail the way a removed dir would.
    const realWrite = fs.writeFileSync;
    mock.method(fs, 'writeFileSync', (p, ...rest) => {
      if (String(p).includes('background-')) throw new Error('ENOENT: simulated removed log dir');
      return realWrite(p, ...rest);
    });

    const rejections = [];
    const onRejection = (err) => rejections.push(err);
    process.on('unhandledRejection', onRejection);

    const exits = [];
    parent._onBackgroundExitRaw((ev) => exits.push(ev));

    try {
      const out = await execute(
        { description: 'd', prompt: 'do it', background: true },
        { agent: parent, signal: new AbortController().signal },
      );
      assert.match(out, /Job ID: bg-/, 'background mode should return a job id immediately');

      // The fire-and-forget finalizer runs on a later turn of the event loop.
      const start = Date.now();
      while (exits.length === 0 && Date.now() - start < 3000) {
        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(exits.length, 1, 'exit event must fire even though the log write failed');
      assert.equal(exits[0].kind, 'delegate');
      // Give any stray rejection a tick to surface.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        rejections.length,
        0,
        `background finalizer must not produce unhandled rejections: ${rejections.map((e) => e.message).join(', ')}`,
      );
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
