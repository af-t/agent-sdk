import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import Agent from '../../agent/agent.js';
import { LIMITS } from '../../support/payload.js';
import { createTraceWriter } from '../../recording/trace-writer.js';

const description =
  'Run a specific task in a subagent. The subagent can use the shared tools, including filesystem and shell operations. Do not run parallel tasks that may edit the same files or processes.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    description: { type: 'string', description: 'Short label for the delegated task.' },
    prompt: {
      type: 'string',
      description: 'Complete instructions for the subagent, including the expected result.',
    },
    persona: { type: 'string', description: 'Optional system instruction for the subagent.' },
    id: {
      type: 'string',
      description: 'Existing subagent ID to reuse with its history. Omit it to create an ID.',
    },
    background: {
      type: 'boolean',
      description:
        'Return immediately with a job ID and log path. The parent receives an exit event when the subagent finishes.',
    },
  },
  required: ['prompt', 'description'],
};

const execute = async ({ description, prompt, persona, id, background = false }, { agent, signal, logger }) => {
  if (signal?.aborted) {
    throw new Error('delegateTask aborted');
  }

  const depth = (agent._delegateDepth || 0) + 1;
  const MAX_DELEGATE_DEPTH = 3;
  if (depth > MAX_DELEGATE_DEPTH) {
    throw new Error(`delegateTask depth limit reached (${MAX_DELEGATE_DEPTH}). Cannot nest deeper.`);
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
      tools: agent.tools.clone(),
      skillRegistry: agent.skillRegistry,
      systemPrompt: persona,
      maxCompletionTokens: agent.maxCompletionTokens || LIMITS.maxSubagentCompletionTokens,
      maxTurns: 1000,
      isSubagent: true,
      restricted: agent.restricted,
      storagePaths: agent._storagePaths ?? undefined,
      appName: agent.appName,
      logger: agent.logger.child({ component: 'agent', agent: 'subagent', subagentId: resolvedId }),
      transport: agent._transport,
    });
    if (typeof agent._sendForTest === 'function') {
      subagent._sendForTest = agent._sendForTest;
    }
    // Nested subagents inherit the depth needed to enforce the limit.
    subagent._delegateDepth = depth;
    agent.subagents.set(resolvedId, subagent);
  } else {
    subagent = agent.subagents.get(resolvedId);
  }

  logger?.info({ component: 'delegateTask', description, background }, 'Starting delegated task');

  if (background) {
    if (!agent) {
      throw new Error('delegateTask background mode requires ctx.agent (an Agent instance).');
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

    // The job controller lets manageJobs and cleanup stop the subagent, while
    // cancellation from the parent still cascades.
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
    agent.backgroundJobs.register(job);

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
      // Cleanup may remove the log directory while the subagent is finishing.
      // The exit event still reports completion if the write fails.
      try {
        fs.writeFileSync(logPath, report + footer);
      } catch (err) {
        logger?.warn({ component: 'delegateTask', error: err }, 'Background log write failed');
      }

      agent._fireBackgroundExit({
        id: bgId,
        kind: 'delegate',
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.endedAt,
        exitCode: job.exitCode,
        // Subagents use AbortController rather than operating-system signals.
        signal: null,
        durationMs: job.endedAt - job.startedAt,
        logPath,
        traceLogPath,
      });
    })().catch((err) => logger?.warn({ component: 'delegateTask', error: err }, 'Background task finalization failed'));

    return (
      `Subagent started in background.\n` +
      `Job ID: ${bgId} (kind: delegate)\n` +
      `Subagent ID: ${resolvedId} (${isNew ? 'new' : 'reused'})\n` +
      `Log: ${logPath}\n` +
      `Trace (live): ${traceLogPath}\n` +
      `Use scheduleWakeup({ delayMs, watch: ['${bgId}'] }) to wait or peek, or use readFile for the log.`
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

      while (!signal?.aborted) {
        if (!subagent.backgroundJobs.hasRunning() && !subagent.isRunning) {
          // autoWake can start another run from a queued microtask.
          await new Promise((r) => setTimeout(r, 50));
          if (!subagent.backgroundJobs.hasRunning() && !subagent.isRunning) {
            break;
          }
        }

        await new Promise((r) => setTimeout(r, 200));
      }

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

export const delegateTask = { name: 'delegateTask', description, inputSchema, execute };
