import crypto from 'node:crypto';
import { callerAbortError, normalizeModelResponse } from './request-client.js';

const DEFAULT_TAIL_BYTES = 4096;

function normalizePrompt(prompt) {
  return Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
}

// Add content to the trailing user message, or start one when the conversation
// ends with something else. Keeping prompts, steers and reminders in a single
// user message avoids stray user-after-user turns in history.
export function appendUserContent(messages, parts) {
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push(...parts);
  } else {
    messages.push({ role: 'user', content: parts });
  }
}

// Slip a system-reminder block in ahead of the last part of the trailing user
// message, so the user's own text stays last. Dropped when the conversation
// ends with a tool result instead.
function injectBlock(messages, block) {
  const lastMsg = messages[messages.length - 1];
  if (lastMsg?.role === 'user' && Array.isArray(lastMsg?.content) && lastMsg.content.length > 0) {
    lastMsg.content.splice(lastMsg.content.length - 1, 0, { type: 'text', text: block });
  }
}

function addUsage(usage, turnUsage) {
  usage.cost += turnUsage.cost;
  usage.tokens += turnUsage.tokens;
  usage.cachedTokens += turnUsage.cachedTokens;
  usage.cacheWriteTokens += turnUsage.cacheWriteTokens;
}

// Fold queued background-exit events into a trailing user message. Returns true
// when something was drained. Shared with the agent's auto-wake path, which
// drains before resuming so the model sees the reminder on its first turn.
export function drainBackgroundExits(backgroundJobs, messages) {
  const events = backgroundJobs.drainExitEvents();
  if (events.length === 0) return false;
  const lines = [];
  for (const event of events) {
    const reasonNote = event.reason ? `, reason: "${event.reason}"` : '';
    if (event.prompt) lines.push(`- ${event.prompt}`);
    lines.push(
      `- ${event.id} (${event.kind}): ${event.status}, exit ${event.exitCode}, ` +
        `${Math.round(event.durationMs / 100) / 10}s, log: ${event.logPath}${reasonNote}`,
    );
    if (Array.isArray(event.watch) && event.watch.length) {
      for (const watchedId of event.watch) {
        lines.push(backgroundJobs.describe(watchedId, event.tailBytes ?? DEFAULT_TAIL_BYTES));
      }
    }
  }
  const text = `<system-reminder>\nBackground job(s) exited:\n${lines.join('\n')}\n</system-reminder>`;
  appendUserContent(messages, [{ type: 'text', text }]);
  return true;
}

// Drives one conversation to completion: request, stop hooks, tool calls,
// repeat. It owns the single active-run promise and the queue of prompts that
// arrive mid-run, and reaches everything else through its collaborators or the
// turn context (`messages`, `usage`, `currentTurn`, `maxTurns`, `broadcast`,
// `signal`, `recorder`, `isStreaming`, `agent`). Payload building, rich-content
// bookkeeping and history-wide state stay with the agent behind the context.
export class RunLoop {
  #requestClient;
  #toolExecutor;
  #lifecycle;
  #backgroundJobs;
  #logger;
  #runningPromise;
  #pendingPrompts = [];

  constructor({ requestClient, toolExecutor, lifecycle, backgroundJobs, logger }) {
    this.#requestClient = requestClient;
    this.#toolExecutor = toolExecutor;
    this.#lifecycle = lifecycle;
    this.#backgroundJobs = backgroundJobs;
    this.#logger = logger.child({ component: 'runLoop' });
  }

  get isRunning() {
    return this.#runningPromise !== undefined;
  }

  // Queue a prompt for the active loop. Non-blocking; returns false when idle
  // (no loop to steer) or when the prompt is empty.
  steer(prompt) {
    if (!this.isRunning) return false;
    return this.#queuePrompt(prompt);
  }

  // Start a run, or hand back the one already in flight after queueing the new
  // prompt for it.
  run(prompt, context) {
    if (this.#runningPromise) {
      this.#queuePrompt(prompt);
      return this.#runningPromise;
    }
    this.#runningPromise = this.#runTurns(prompt, context).finally(async () => {
      this.#runningPromise = undefined;
      // Safety net: a prompt queued as the loop exited abnormally still lands
      // in history instead of disappearing with the run.
      await this.#drainPending(context);
    });
    return this.#runningPromise;
  }

  #queuePrompt(prompt) {
    if (prompt == null || prompt === '') return false;
    if (Array.isArray(prompt) && prompt.length === 0) return false;
    this.#pendingPrompts.push(normalizePrompt(prompt));
    return true;
  }

  // Flush queued steer prompts into the conversation as a trailing user message.
  async #drainPending(context) {
    if (this.#pendingPrompts.length === 0) return false;
    const items = this.#pendingPrompts.splice(0, this.#pendingPrompts.length);
    for (const parts of items) appendUserContent(context.messages, parts);
    await context.broadcast({ steer_applied: { count: items.length } });
    return true;
  }

  // Send one turn's payload and account for what it cost. `onDegrade` is only
  // supplied by the main turn request, the one place that can mirror a dropped
  // attachment back into the conversation.
  async #sendRequest(payload, context, { onDegrade } = {}) {
    const { agent, usage, signal, isStreaming, broadcast } = context;

    // Test seam: `_sendForTest` stands in for the whole transport, so the loop
    // can be driven with recorded or scripted provider responses.
    if (typeof agent._sendForTest === 'function') {
      const stubbed = normalizeModelResponse(await agent._sendForTest(payload));
      addUsage(usage, stubbed.usage);
      return stubbed;
    }

    const response = await this.#requestClient.request(payload, {
      signal,
      stream: isStreaming,
      onChunk: (chunk) =>
        broadcast({
          content_delta: chunk.contentDelta || null,
          content: chunk.content || null,
          reasoning_delta: chunk.reasoningDelta || null,
          reasoning: chunk.reasoning || null,
        }),
      onDegrade,
    });
    addUsage(usage, response.usage);

    // Streaming assembles tool calls from many deltas, so announce them once the
    // stream is whole. The non-streaming path has no partial state to report.
    if (isStreaming && response.message?.tool_calls) {
      await broadcast({ tool_calls: response.message.tool_calls });
    }
    return response;
  }

  async #runTurns(prompt, context) {
    const { agent, messages, signal, isStreaming, broadcast } = context;

    // freeze before prompt append
    const wasFresh = messages.length < 1;

    if (prompt) {
      appendUserContent(messages, normalizePrompt(prompt));
    }

    // Surface background-exit reminders that queued while idle so the model
    // sees them on the first turn (merged with the prompt) instead of only
    // after the first tool group. Late exits during the run still drain at
    // tool boundaries / termination below.
    drainBackgroundExits(this.#backgroundJobs, messages);

    let loopCount = 0;

    while (true) {
      // Check abort signal
      if (signal?.aborted) {
        throw new Error('Agent run aborted');
      }

      if (context.maxTurns > 0 && loopCount >= context.maxTurns) {
        this.#logger.warn({ maxTurns: context.maxTurns }, 'Maximum request turns reached; forcing break');
        if (agent.isSubagent) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg?.role === 'tool') {
            return `[LIMIT_REACHED] The agent reached its maximum turn limit (${context.maxTurns}). \nLast tool result: ${lastMsg.content}`;
          }
        }
        break;
      }
      loopCount++;
      context.currentTurn = loopCount;

      // subagent turn-limit: nudge final summary on last tool turn
      if (agent.isSubagent && context.maxTurns > 0 && loopCount === context.maxTurns) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'tool') {
          lastMsg.content +=
            '\n\n[SYSTEM] You have reached the maximum allowed request turns. Please provide a final summary of your work now and stop calling tools.';
        }
      }

      const isFirstTurn = wasFresh && loopCount === 1;

      const injectorContext = {
        messages,
        usage: context.usage,
        turn: messages.length,
        logger: agent.logger,
      };

      // First-turn output is persisted into the conversation (always visible in history).
      if (isFirstTurn) {
        const firstTurnOut = await this.#lifecycle.applyInjectors('first-turn', injectorContext);
        const text = firstTurnOut.join('\n\n').trim();
        if (text.length > 0) {
          injectBlock(messages, `<system-reminder>\n${text}\n</system-reminder>`);
        }
      }

      // Per-turn output is also persisted into the conversation so the history
      // has consistent structure across turns, avoiding cache misses when the
      // user sends a new prompt in a subsequent run() call. If the last message
      // is not a user message (e.g. tool result), the block is silently dropped.
      {
        const perTurnOut = await this.#lifecycle.applyInjectors('per-turn', injectorContext);
        const text = perTurnOut.join('\n\n').trim();
        if (text.length > 0) {
          injectBlock(messages, `<system-reminder>\n${text}\n</system-reminder>`);
        }
      }

      // Build payload + onBeforeRequest hooks ONCE per turn.
      // Only the network call is retried; injectors and hooks do not run again.
      const payload = await agent._buildPayload();
      context.recorder?.request(loopCount, payload);
      let response;
      try {
        response = await this.#sendRequest(payload, context, {
          onDegrade: (degraded) => agent._dropRichContent(degraded),
        });
      } catch (err) {
        agent._closeRichContentWindow({ sent: false });
        throw err;
      }
      agent._closeRichContentWindow({ sent: true });
      context.recorder?.response(loopCount, response.raw);
      // Response landed after the caller aborted: don't commit or act on it.
      if (signal?.aborted) throw callerAbortError();

      const message = response.message;
      if (!message) {
        this.#logger.warn({}, 'LLM returned no message; breaking loop');
        break;
      }

      let { content, tool_calls } = message;
      let reasoning = response.reasoning;
      let reasoning_details = response.reasoningDetails;
      let finish_reason = response.finishReason;

      // Stop hooks / empty-turn recovery run only on a terminal (no-tool_calls)
      // turn, BEFORE the assistant message is committed: so an empty turn never
      // lands in history as a trailing assistant message (keeps the conversation
      // continuation-safe and avoids a 400 on the next run).
      if (!tool_calls || tool_calls.length === 0) {
        const resolution = await this.#lifecycle.resolveStop({
          payload,
          isStreaming,
          signal,
          turn: loopCount,
          content,
          reasoning,
          reasoning_details,
          finish_reason,
          usage: context.usage,
          messages,
          recoveryHook: agent._recoveryHook,
          sendModelRequest: (retryPayload) => this.#sendRequest(retryPayload, context),
        });
        if (resolution.continue) {
          await broadcast({ stop_recovery: { turn: loopCount, finish_reason, reasoning } });
          appendUserContent(messages, normalizePrompt(resolution.prompt));
          continue;
        }
        content = resolution.content;
        reasoning = resolution.reasoning;
        reasoning_details = resolution.reasoning_details;
        tool_calls = resolution.tool_calls;
        finish_reason = resolution.finish_reason;
      }

      if (signal?.aborted) throw callerAbortError();

      const isEmptyTerminal =
        (!tool_calls || tool_calls.length === 0) && (content == null || String(content).trim() === '');

      if (isEmptyTerminal) {
        // Empty terminal turn (recovery exhausted, or disabled). Do not commit a
        // trailing empty assistant message; terminate and return the content as-is.
        context.recorder?.snapshot(loopCount, messages, context.usage);
        await broadcast({
          turn_end: { turn: loopCount, terminal: true, finish_reason, empty: true, reasoning },
        });
        if (await this.#drainPending(context)) continue;
        // A late bg exit on this terminal turn: with autoWake, resume so the
        // model acts on it rather than stranding the reminder in history.
        if (drainBackgroundExits(this.#backgroundJobs, messages) && agent.autoWake) continue;
        return content ?? '';
      }

      // Assign ids once so tool results match the assistant message
      if (tool_calls) {
        for (const toolCall of tool_calls) {
          if (!toolCall.id) toolCall.id = `call_${crypto.randomUUID()}`;
        }
      }

      messages.push({ role: 'assistant', reasoning, reasoning_details, content, tool_calls });
      context.recorder?.recordAssistant(loopCount, { content, reasoning, tool_calls });

      if (!tool_calls || tool_calls.length === 0) {
        context.recorder?.snapshot(loopCount, messages, context.usage);
        await broadcast({ turn_end: { turn: loopCount, terminal: true, finish_reason } });
        // A steer delivered during the final turn keeps the loop alive.
        if (await this.#drainPending(context)) continue;
        // Fold any late bg exits into messages before terminating; with
        // autoWake, resume so the model acts on the exit instead of leaving
        // the reminder stranded in history.
        if (drainBackgroundExits(this.#backgroundJobs, messages) && agent.autoWake) continue;
        break;
      }

      const toolContext = {
        agent,
        logger: agent.logger,
        maxToolOutput: agent.maxToolOutputChars,
        signal,
        multimodalUnsupported: agent._multimodalUnsupported,
        broadcast,
      };
      const results = await Promise.all(
        tool_calls.map((toolCall) => this.#toolExecutor.execute(toolCall, toolContext)),
      );

      const richPartsOrdered = [];
      const richToolIds = [];
      for (const { richParts, ...toolMessage } of results) {
        messages.push(toolMessage);
        if (richParts.length > 0) {
          richPartsOrdered.push(...richParts);
          richToolIds.push(toolMessage.tool_call_id);
        }
      }
      if (richPartsOrdered.length > 0) {
        agent._appendRichContent(richPartsOrdered, richToolIds);
      }

      if (signal?.aborted) {
        throw new Error('Agent run aborted');
      }

      // Fold bg exits that arrived during tool execution into messages.
      drainBackgroundExits(this.#backgroundJobs, messages);
      // Flush any steer queued during this turn's tool execution.
      await this.#drainPending(context);
      context.recorder?.snapshot(loopCount, messages, context.usage);
      this.#lifecycle.resetStopAttempts();
      await broadcast({ turn_end: { turn: loopCount, terminal: false, finish_reason } });
    }

    return messages[messages.length - 1].content;
  }
}
