import { ConfigError } from './errors.js';
import { logger } from './logger.js';

function isAgentLike(a) {
  return (
    a &&
    typeof a.subscribe === 'function' &&
    typeof a.steer === 'function' &&
    typeof a.run === 'function' &&
    a.usage &&
    typeof a.currentTurn === 'number'
  );
}

function freshTurn() {
  return { content: '', reasoning: '', toolCalls: null, toolEvents: [], callSigs: [], hadError: false };
}

export function createCopilot({
  primary,
  supervisor,
  window = 3,
  triggers,
  traceCap = 2000,
  onDecision,
  signal,
  goal,
} = {}) {
  if (!isAgentLike(primary)) throw new ConfigError('createCopilot: primary must be an Agent-like object');
  if (!isAgentLike(supervisor)) throw new ConfigError('createCopilot: supervisor must be an Agent-like object');

  let controller = null;
  let dispose = null;
  let consumerAbortHandler = null;
  let started = false;

  let cur = freshTurn();
  const winBuf = [];

  function onEvent(event) {
    try {
      if (!event || typeof event !== 'object') return;
      if (typeof event.content === 'string') cur.content = event.content;
      if (typeof event.reasoning === 'string') cur.reasoning = event.reasoning;
      if (event.tool_calls) {
        cur.toolCalls = event.tool_calls;
        cur.callSigs = event.tool_calls.map(
          (c) => `${c.function?.name || c.name || '?'}:${c.function?.arguments || ''}`,
        );
      }
      if (event.tool_start) cur.toolEvents.push({ tool_start: event.tool_start });
      if (event.tool_end) {
        cur.toolEvents.push({ tool_end: event.tool_end });
        if (event.tool_end.error !== undefined) cur.hadError = true;
      }
      if (event.turn_end) finalizeTurn(event.turn_end);
    } catch (err) {
      logger.warn(`copilot event handler threw: ${err.message}`);
    }
  }

  function finalizeTurn(_meta) {
    const turn = cur;
    cur = freshTurn();
    winBuf.push({
      content: turn.content,
      reasoning: turn.reasoning,
      toolCalls: turn.toolCalls,
      toolEvents: turn.toolEvents,
      callSigs: turn.callSigs,
    });
    while (winBuf.length > window) winBuf.shift();
    // gate + evaluation wired in later tasks
  }

  function start() {
    if (started) return controller.signal;
    started = true;
    controller = new AbortController();
    if (signal) {
      if (signal.aborted) controller.abort();
      else {
        consumerAbortHandler = () => controller.abort();
        signal.addEventListener('abort', consumerAbortHandler);
      }
    }
    dispose = primary.subscribe(onEvent);
    return controller.signal;
  }

  function stop() {
    if (!started) return;
    started = false;
    if (dispose) {
      dispose();
      dispose = null;
    }
    if (signal && consumerAbortHandler) {
      signal.removeEventListener('abort', consumerAbortHandler);
      consumerAbortHandler = null;
    }
  }

  return {
    start,
    stop,
    get signal() {
      return controller ? controller.signal : null;
    },
  };
}
