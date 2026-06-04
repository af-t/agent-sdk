import { ConfigError } from './errors.js';
import { logger } from './logger.js';
import { createTraceFormatter } from './trace-writer.js';

export function extractGoal(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      for (let j = m.content.length - 1; j >= 0; j--) {
        const p = m.content[j];
        if (p && p.type === 'text' && typeof p.text === 'string') {
          if (!p.text.startsWith('<system-reminder>')) {
            return p.text;
          }
        }
      }
      const t = m.content.find((p) => p && p.type === 'text' && typeof p.text === 'string');
      if (t) return t.text;
    }
  }
  return '';
}

export function renderWindow(win, traceCap) {
  const fmt = createTraceFormatter({ toolOutputCap: traceCap });
  let out = '';
  for (const t of win) {
    fmt.step({ content: t.content, reasoning: t.reasoning });
    if (t.toolCalls) {
      out += fmt.step({ tool_calls: t.toolCalls });
      for (const ev of t.toolEvents) out += fmt.step(ev);
    }
  }
  out += fmt.flush();
  return out;
}

export function buildInput(goal, reasons, win, traceCap) {
  const trace = renderWindow(win, traceCap);
  return [
    'You are a supervising co-pilot watching another AI agent work toward a GOAL.',
    'Decide whether to intervene. Prefer doing nothing.',
    'Respond with ONLY a JSON object: {"action":"steer"|"abort"|"none","prompt":"...","reason":"..."}.',
    'Use "steer" with a short, concrete corrective instruction (in "prompt") when the agent drifts or loops.',
    'Use "abort" only when the task is unrecoverable or clearly wasteful. Otherwise use "none".',
    '',
    `GOAL: ${goal || '(unknown)'}`,
    `TRIGGER: ${reasons.join(', ')}`,
    '--- recent trace (last turns) ---',
    trace,
  ].join('\n');
}

function resolveTrigger(val, dflt) {
  if (val === false) return false;
  if (val === undefined || val === true) return dflt;
  if (typeof val === 'object') return { ...dflt, ...val };
  return dflt;
}

export function normalizeTriggers(cfg = {}) {
  return {
    toolError: cfg.toolError === false ? false : true,
    repeatedCall: resolveTrigger(cfg.repeatedCall, { times: 3 }),
    costDelta: cfg.costDelta ? resolveTrigger(cfg.costDelta, { threshold: 0 }) : false,
    everyNTurns: resolveTrigger(cfg.everyNTurns, { n: 5 }),
    nearMaxTurns: resolveTrigger(cfg.nearMaxTurns, { within: 2 }),
    custom: Array.isArray(cfg.custom) ? cfg.custom : [],
  };
}

export function buildReasons(ctx, t) {
  const reasons = [];
  if (t.toolError && ctx.hadError) reasons.push('toolError');
  if (t.repeatedCall) {
    const counts = new Map();
    for (const w of ctx.recentTurns) {
      for (const s of w.callSigs || []) {
        counts.set(s, (counts.get(s) || 0) + 1);
      }
    }
    for (const c of counts.values()) {
      if (c >= t.repeatedCall.times) {
        reasons.push('repeatedCall');
        break;
      }
    }
  }
  if (t.costDelta && ctx.costSinceLast > t.costDelta.threshold) reasons.push('costDelta');
  if (t.everyNTurns && ctx.turn % t.everyNTurns.n === 0) reasons.push('everyNTurns');
  if (t.nearMaxTurns && ctx.maxTurns > 0 && ctx.maxTurns - ctx.turn <= t.nearMaxTurns.within)
    reasons.push('nearMaxTurns');
  for (const fn of t.custom) {
    let r;
    try {
      r = fn(ctx);
    } catch (err) {
      logger.warn(`copilot custom trigger threw: ${err.message}`);
      continue;
    }
    if (r === true) reasons.push('custom');
    else if (typeof r === 'string' && r) reasons.push(r);
  }
  return reasons;
}

function coerceDecision(obj) {
  if (!obj || typeof obj !== 'object') return { action: 'none' };
  if (obj.action === 'steer') {
    if (typeof obj.prompt === 'string' && obj.prompt.trim()) {
      return { action: 'steer', prompt: obj.prompt, reason: obj.reason };
    }
    return { action: 'none', reason: obj.reason };
  }
  if (obj.action === 'abort') return { action: 'abort', reason: obj.reason };
  return { action: 'none', reason: obj.reason };
}

export function parseDecision(text) {
  if (text && typeof text === 'object') return coerceDecision(text);
  if (typeof text !== 'string') return { action: 'none' };
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch {
        obj = null;
      }
    }
  }
  return coerceDecision(obj);
}

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
  let evaluating = false;
  let lastCost = 0;
  let capturedGoal = typeof goal === 'string' ? goal : '';
  const trig = normalizeTriggers(triggers);

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

  function finalizeTurn(meta) {
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

    if (!capturedGoal) capturedGoal = extractGoal(primary.messages);

    const costNow = primary.usage?.cost || 0;
    const ctx = {
      turn: meta.turn,
      terminal: !!meta.terminal,
      recentTurns: winBuf,
      lastTurn: turn,
      usage: primary.usage,
      costSinceLast: costNow - lastCost,
      maxTurns: primary.maxTurns,
      hadError: turn.hadError,
    };
    const reasons = buildReasons(ctx, trig);
    if (reasons.length === 0) return;
    if (evaluating) return;

    lastCost = costNow;
    evaluating = true;
    evaluate(reasons)
      .catch((err) => logger.warn(`copilot evaluation failed: ${err.message}`))
      .finally(() => {
        evaluating = false;
      });
  }

  function emitDecision(decision, reasons) {
    if (typeof onDecision !== 'function') return;
    try {
      onDecision({ ...decision, triggers: reasons });
    } catch (err) {
      logger.warn(`copilot onDecision threw: ${err.message}`);
    }
  }

  async function evaluate(reasons) {
    const input = buildInput(capturedGoal, reasons, winBuf, traceCap);
    if (supervisor.responseFormat === undefined) supervisor.responseFormat = { type: 'json_object' };
    supervisor.messages = []; // independent evaluation; usage preserved
    let raw;
    try {
      raw = await supervisor.run(input);
    } catch (err) {
      logger.warn(`copilot supervisor.run threw: ${err.message}`);
      emitDecision({ action: 'none', reason: `supervisor error: ${err.message}` }, reasons);
      return;
    }
    const decision = parseDecision(raw);
    emitDecision(decision, reasons);
    if (decision.action === 'steer') primary.steer(decision.prompt);
    else if (decision.action === 'abort') controller?.abort();
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
