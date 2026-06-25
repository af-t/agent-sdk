import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// A background Delegate's finalizer must never crash the host process if the
// log write fails (e.g. cleanup() removed the tmp dir mid-flight). The exit
// event must still fire so the parent learns the job ended.
describe('Delegate background — log write failure does not crash the host', () => {
  let Agent;
  let execute;

  before(async () => {
    Agent = (await import('../../src/core/agent.js')).default;
    execute = (await import('../../src/tools/system/delegate.js')).execute;
  });

  after(() => {
    mock.restoreAll();
  });

  it('survives a failing background log write and still fires the exit event', async () => {
    const parent = new Agent({ apiKey: 'sk-test' });
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

      // Wait for the fire-and-forget finalizer to run.
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
      await parent.cleanup();
    }
  });
});
