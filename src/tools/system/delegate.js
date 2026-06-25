import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Agent from '../../core/agent.js';
import { CONSTANTS } from '../../core/utils.js';
import logger from '../../core/logger.js';
import { createTraceWriter } from '../../core/trace-writer.js';

export const name = 'Delegate';
export const description =
  'Delegate a specific task to a specialized sub-agent. Use this for complex research, repetitive operations, or tasks with high-volume output to keep the main session history clean. Side effect: spawns a subagent that may itself touch the filesystem and shell. Avoid parallel Delegate calls targeting overlapping work.';
export const input_schema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Explain why to use this tool' },
    prompt: {
      type: 'string',
      description:
        'Specific instructions for the subagent\n\nIt is highly recommended to ask for a summary so that the context obtained is clear',
    },
    persona: { type: 'string', description: 'Specific System instruction or Rule or Personality for subagent' },
    id: {
      type: 'string',
      description:
        'Subagent ID. If provided and already exists, the same subagent is reused (history preserved). If omitted, a short random ID is auto-generated.',
    },
    background: {
      type: 'boolean',
      description:
        'Run the subagent in the background. Returns immediately with a job ID and log path; the parent receives an exit notification when the subagent finishes.',
    },
  },
  required: ['prompt', 'description'],
};

export const execute = async ({ description, prompt, persona, id, background = false }, { agent, signal }) => {
  if (signal?.aborted) {
    throw new Error('Delegate aborted');
  }

  const depth = (agent._delegateDepth || 0) + 1;
  const MAX_DELEGATE_DEPTH = 3;
  if (depth > MAX_DELEGATE_DEPTH) {
    throw new Error(`Delegate depth limit reached (${MAX_DELEGATE_DEPTH}). Cannot nest deeper.`);
  }

  let resolvedId = id;
  if (!resolvedId) {
    resolvedId = Math.random().toString(36).slice(2, 7);
    if (agent.subagents.has(resolvedId)) resolvedId = Math.random().toString(36).slice(2, 7);
  }

  const isNew = !agent.subagents.has(resolvedId);
  let subagent;

  if (isNew) {
    subagent = new Agent({
      apiKey: agent.apiKey,
      baseUrl: agent.baseUrl,
      model: agent.model,
      provider: agent.provider,
      tools: agent.tools,
      systemPrompt: persona,
      maxCompletionTokens: agent.maxCompletionTokens || CONSTANTS.MAX_COMPLETION_TOKENS_SUBAGENT,
      maxTurns: 1000,
      isSubagent: true,
      restricted: agent.restricted,
      storagePaths: agent._storagePaths ?? undefined,
      appName: agent.appName,
    });
    if (typeof agent._sendForTest === 'function') {
      subagent._sendForTest = agent._sendForTest;
    }
    // Propagate depth so nested Delegate hits the limit
    subagent._delegateDepth = depth;
    agent.subagents.set(resolvedId, subagent);
  } else {
    subagent = agent.subagents.get(resolvedId);
  }

  logger.info('Spawning subagent for:', description);

  if (background) {
    if (!agent) {
      throw new Error('Delegate background mode requires ctx.agent (an Agent instance).');
    }
    const bgId = 'bg-' + crypto.randomBytes(4).toString('hex').slice(0, 5);
    const dir = agent._resolveBackgroundLogDir();
    const logPath = path.join(dir, `background-${bgId}.log`);
    const traceLogPath = path.join(dir, `trace-${bgId}.log`);
    const writer = createTraceWriter(traceLogPath);
    const startedAt = Date.now();
    const snapshotBefore = {
      cost: subagent.usage.cost,
      tokens: subagent.usage.tokens,
    };

    // Per-job controller so Jobs/cleanup can stop this subagent; keep parent abort cascading.
    const jobController = new AbortController();
    if (signal) {
      if (signal.aborted) jobController.abort();
      else signal.addEventListener('abort', () => jobController.abort(), { once: true });
    }

    const job = {
      id: bgId,
      kind: 'delegate',
      subagent,
      child: null,
      controller: jobController,
      logPath,
      traceLogPath,
      startedAt,
      endedAt: null,
      exitCode: null,
      status: 'running',
      reason: 'explicit',
    };
    agent.backgroundJobs.set(bgId, job);

    // Fire-and-forget the subagent loop.
    (async () => {
      let report;
      let crashed = false;
      try {
        report = await subagent.run(prompt, writer.notify, { signal: jobController.signal });
      } catch (err) {
        crashed = true;
        report = `Error: ${err.message}`;
      }
      await writer.close().catch(() => {});
      const wasAborted = jobController.signal.aborted;
      job.endedAt = Date.now();
      job.exitCode = wasAborted || crashed ? -1 : 0;
      job.status = wasAborted ? 'killed' : crashed ? 'crashed' : 'exited';

      const costDelta = subagent.usage.cost - snapshotBefore.cost;
      const tokensDelta = subagent.usage.tokens - snapshotBefore.tokens;
      agent.usage.cost += costDelta;
      agent.usage.tokens += tokensDelta;

      const footer =
        `\n\n---\n` +
        `Subagent ID: ${resolvedId} (${isNew ? 'new' : 'reused'})\n` +
        `Duration: ${((job.endedAt - job.startedAt) / 1000).toFixed(2)}s\n` +
        `Usage delta: cost=$${costDelta.toFixed(6)}, tokens=${tokensDelta}\n` +
        `Status: ${job.status}`;
      // A removed log dir (e.g. cleanup() ran mid-flight) must not crash the
      // host; still fire the exit event so the parent learns the job ended.
      try {
        fs.writeFileSync(logPath, report + footer);
      } catch (err) {
        logger.warn(`Delegate background log write failed: ${err.message}`);
      }

      agent._fireBackgroundExit({
        id: bgId,
        kind: 'delegate',
        exitCode: job.exitCode,
        durationMs: job.endedAt - job.startedAt,
        status: job.status,
        logPath,
        traceLogPath,
      });
    })().catch((err) => logger.warn(`Delegate background finalize failed: ${err.message}`));

    return (
      `Subagent started in background.\n` +
      `Job ID: ${bgId} (kind: delegate)\n` +
      `Subagent ID: ${resolvedId} (${isNew ? 'new' : 'reused'})\n` +
      `Log: ${logPath}\n` +
      `Trace (live): ${traceLogPath}\n` +
      `Use Remind({ wait_ms, watch: ['${bgId}'] }) to wait/peek, or Read the log.`
    );
  }

  try {
    const usageBefore = { cost: subagent.usage.cost, tokens: subagent.usage.tokens };
    const msgsBefore = subagent.messages.length;
    const startTime = Date.now();

    const traceId = crypto.randomBytes(4).toString('hex').slice(0, 5);
    const logDir =
      typeof agent._resolveBackgroundLogDir === 'function'
        ? agent._resolveBackgroundLogDir()
        : agent._storagePaths?.tmpDir || os.tmpdir();
    const traceLogPath = path.join(logDir, `trace-${traceId}.log`);
    const writer = createTraceWriter(traceLogPath);

    let report;
    try {
      report = await subagent.run(prompt, writer.notify, { signal });

      // Wait until subagent is fully idle (no running background jobs, and not currently running a loop)
      while (!signal?.aborted) {
        const hasRunningJobs =
          subagent.backgroundJobs && Array.from(subagent.backgroundJobs.values()).some((j) => j.status === 'running');

        if (!hasRunningJobs && !subagent.isRunning) {
          // Wait a short tick to allow pending microtasks (like autoWake) to fire
          await new Promise((r) => setTimeout(r, 50));
          const stillRunningJobs =
            subagent.backgroundJobs && Array.from(subagent.backgroundJobs.values()).some((j) => j.status === 'running');
          if (!stillRunningJobs && !subagent.isRunning) {
            break;
          }
        }

        await new Promise((r) => setTimeout(r, 200));
      }

      // If autoWake triggered subsequent runs, update the report to the final assistant message
      if (subagent.messages.length > 0) {
        const lastMsg = subagent.messages[subagent.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content) {
          const textContent = Array.isArray(lastMsg.content)
            ? lastMsg.content
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            : lastMsg.content;
          if (textContent) {
            report = textContent;
          }
        }
      }
    } finally {
      await writer.close();
    }

    const elapsed = Date.now() - startTime;
    const toolCalls = subagent.messages.slice(msgsBefore).filter((m) => m.role === 'tool').length;
    agent.usage.cost += subagent.usage.cost - usageBefore.cost;
    agent.usage.tokens += subagent.usage.tokens - usageBefore.tokens;

    const status = isNew ? 'new' : 'reused';
    const duration =
      elapsed < 60000
        ? `${Math.round(elapsed / 1000)}s`
        : `${Math.floor(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`;
    const footer =
      `\n\n---\nSubagent ID: ${resolvedId} (${status})\nTool calls: ${toolCalls}\n` +
      `Duration: ${duration}\nTrace: ${traceLogPath}`;
    return report + footer;
  } catch (err) {
    throw new Error(`Delegation failed: ${err.message}`, { cause: err });
  }
};
