import { ConfigError } from '../support/errors.js';

const VALID_INJECTOR_SCOPES = new Set(['first-turn', 'per-turn']);

// Ceiling on stop-hook retry/continue cycles for a single terminal turn, so a
// hook that always asks for more (a misbehaving hook or a model that never recovers) can't
// loop the run forever.
const MAX_STOP_RECOVERY = 8;

const DEFAULT_EMPTY_TURN_RETRIES = 2;
const DEFAULT_EMPTY_TURN_NUDGE =
  'Your previous turn produced reasoning but no response and no tool call. Provide your final answer now, or call a tool to proceed.';

function validateInjector({ name, scope, run }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConfigError('Injector name must be a non-empty string');
  }
  if (!VALID_INJECTOR_SCOPES.has(scope)) {
    const valid = [...VALID_INJECTOR_SCOPES].join(', ');
    throw new ConfigError(`Injector scope must be one of ${valid}, not ${String(scope)}`);
  }
  if (typeof run !== 'function') {
    throw new ConfigError(`Injector '${name}' requires run to be a function`);
  }
}

// The same name may be registered in more than one scope, so injectors are
// keyed on scope and name together.
function injectorKey(scope, name) {
  return `${scope}:${name}`;
}

// The built-in stop hook recovers a terminal turn whose content is empty. It
// escalates a configured number of raw retries to one nudge and then stops. A
// non-retryable error on a retry (a 400 history-schema error, say) jumps
// straight to the nudge. It always runs after the caller's own stop hooks, which
// a shared hook list cannot express, so the agent holds it and hands it to
// resolveStop per terminal turn.
export function createEmptyTurnRecoveryHook(emptyTurnRecovery, config) {
  let enabled = true;
  let retries = DEFAULT_EMPTY_TURN_RETRIES;
  let nudge = DEFAULT_EMPTY_TURN_NUDGE;

  if (emptyTurnRecovery === false) {
    enabled = false;
  } else if (emptyTurnRecovery && typeof emptyTurnRecovery === 'object') {
    if (emptyTurnRecovery.enabled !== undefined) enabled = !!emptyTurnRecovery.enabled;
    if (emptyTurnRecovery.retries !== undefined) retries = parseInt(emptyTurnRecovery.retries);
    if (typeof emptyTurnRecovery.nudge === 'string' && emptyTurnRecovery.nudge.trim().length > 0) {
      nudge = emptyTurnRecovery.nudge;
    }
  } else if (emptyTurnRecovery === undefined) {
    if (config.emptyTurnRecovery !== undefined) enabled = config.emptyTurnRecovery;
    if (config.emptyTurnRetries !== undefined) retries = config.emptyTurnRetries;
  }
  if (Number.isNaN(retries) || retries < 0) retries = DEFAULT_EMPTY_TURN_RETRIES;
  if (!enabled) return null;

  // The configured nudge is the inner text; wrap it as a system reminder so
  // the model reads it as framework guidance, not a user turn (consistent with
  // how injectors and background-exit drains surface machine-generated messages).
  const prompt = `<system-reminder>\n${nudge}\n</system-reminder>`;
  return function emptyTurnRecovery({ content, attempt, lastError }) {
    const empty = content == null || String(content).trim() === '';
    if (!empty) return undefined; // non-empty terminal turn: allow normal stop
    if (lastError) {
      return attempt > retries ? { action: 'stop' } : { action: 'continue', prompt };
    }
    if (attempt < retries) return { action: 'retry' };
    if (attempt === retries) return { action: 'continue', prompt };
    return { action: 'stop' };
  };
}

// Lifecycle owns injector and hook registration, disposal, error isolation,
// and the stop-recovery loop that decides whether a
// terminal turn ends the run, retries, or continues with a nudge.
export class Lifecycle {
  #stopAttempts = 0;

  constructor({ logger }) {
    this.logger = logger.child({ component: 'lifecycle' });
    this.injectors = new Map();
    this.beforeRequestHandlers = [];
    this.stopHandlers = [];
  }

  registerInjector({ name, scope, run } = {}) {
    validateInjector({ name, scope, run });
    const key = injectorKey(scope, name);
    if (this.injectors.has(key)) {
      throw new ConfigError(`Injector '${name}' is already registered in scope '${scope}'`);
    }
    this.injectors.set(key, { name, scope, run });
    return () => this.injectors.delete(key);
  }

  unregisterInjector(name) {
    for (const [key, entry] of this.injectors) {
      if (entry.name === name) this.injectors.delete(key);
    }
  }

  onBeforeRequest(handler) {
    if (typeof handler !== 'function') {
      throw new ConfigError('onBeforeRequest expects a function');
    }
    this.beforeRequestHandlers.push(handler);
    return () => {
      const idx = this.beforeRequestHandlers.indexOf(handler);
      if (idx !== -1) this.beforeRequestHandlers.splice(idx, 1);
    };
  }

  // Stop hooks fire on a terminal turn with no tool calls. A hook can allow the
  // stop, retry the same payload, or continue with a user nudge. User hooks run
  // before the recovery hook passed to resolveStop, and the first non-stop
  // decision wins. Registration returns a disposer.
  onStop(handler) {
    if (typeof handler !== 'function') {
      throw new ConfigError('onStop expects a function');
    }
    this.stopHandlers.push(handler);
    return () => {
      const idx = this.stopHandlers.indexOf(handler);
      if (idx !== -1) this.stopHandlers.splice(idx, 1);
    };
  }

  // Run every injector registered for `scope`, in registration order, and
  // collect the non-empty string results. An injector that throws is logged
  // and skipped so one bad injector cannot block the others.
  async applyInjectors(scope, context) {
    const out = [];
    for (const entry of this.injectors.values()) {
      if (entry.scope !== scope) continue;
      let result;
      try {
        result = await entry.run(context);
      } catch (err) {
        this.logger.warn({ injector: entry.name, scope, error: err }, 'Agent injector failed');
        continue;
      }
      if (typeof result === 'string' && result.trim().length > 0) {
        out.push(result);
      }
    }
    return out;
  }

  async runBeforeRequest(payload) {
    for (const handler of this.beforeRequestHandlers) {
      await handler(payload);
    }
  }

  // Run stop hooks in order (user hooks first, then `recoveryHook` if given).
  // The first decision whose action is not 'stop' wins.
  async #runStopHooks(ctx, recoveryHook) {
    const hooks = recoveryHook ? [...this.stopHandlers, recoveryHook] : this.stopHandlers;
    for (const handler of hooks) {
      let decision;
      try {
        decision = await handler(ctx);
      } catch (err) {
        this.logger.warn({ error: err }, 'Stop hook failed');
        continue;
      }
      if (decision && decision.action && decision.action !== 'stop') {
        return decision;
      }
    }
    return undefined;
  }

  // A turn with tool calls clears the recovery counter because the budget
  // applies to one empty-turn streak rather than a whole run.
  resetStopAttempts() {
    this.#stopAttempts = 0;
  }

  // Resolve a terminal turn with no tool calls through stop hooks. The method may resend the same
  // payload through `sendModelRequest` (raw retry) and re-evaluate, request a
  // nudge, or allow the stop. It never commits an assistant message because the
  // caller decides based on the result. Returns { continue: true, prompt } for a
  // nudge, otherwise { content, reasoning, reasoning_details, tool_calls,
  // finish_reason } to adopt.
  async resolveStop({
    payload,
    isStreaming,
    signal,
    turn,
    content,
    reasoning,
    reasoning_details,
    finish_reason,
    usage,
    messages,
    recoveryHook,
    sendModelRequest,
  }) {
    let tool_calls;
    let lastError;
    while (true) {
      // Cancellation between retries ends recovery with the current message.
      // This keeps stop latency to at most one in-flight request.
      if (signal?.aborted) {
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }

      if (this.#stopAttempts > MAX_STOP_RECOVERY) {
        this.logger.warn(
          { maxStopRecovery: MAX_STOP_RECOVERY },
          'Stop recovery reached its limit, so the run is stopping',
        );
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }

      const decision = await this.#runStopHooks(
        {
          content,
          reasoning,
          finishReason: finish_reason,
          turn,
          attempt: this.#stopAttempts,
          usage,
          messages,
          lastError,
        },
        recoveryHook,
      );
      const action = decision?.action ?? 'stop';

      if (action === 'continue') {
        this.#stopAttempts++;
        return { continue: true, prompt: decision.prompt };
      }

      if (action !== 'retry') {
        // A stop or unknown action permits termination with the current message.
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }

      // A retry resends the identical payload.
      this.#stopAttempts++;
      try {
        const retryResponse = await sendModelRequest(payload, { isStreaming, signal });
        const retryMessage = retryResponse.message;
        content = retryMessage?.content || null;
        reasoning = retryMessage?.reasoning || undefined;
        reasoning_details = retryMessage?.reasoning_details || undefined;
        tool_calls = retryMessage?.tool_calls || null;
        finish_reason = retryResponse.finishReason;
        lastError = null;
      } catch (err) {
        // A failed raw retry, including a hard 4xx response, leaves
        // content empty and exposes the error through lastError. The recovery hook uses
        // lastError to escalate straight to the nudge on the next iteration.
        lastError = err;
      }

      const recovered = tool_calls && tool_calls.length > 0;
      if (recovered) {
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }
      // Empty content advances the attempt and runs the hooks again.
    }
  }
}
