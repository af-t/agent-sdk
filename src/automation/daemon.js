import { ConfigError } from '../support/errors.js';
import { resolveLogger } from '../support/logger.js';

const SOFT_CAP = 1000;

function isAgentLike(a) {
  return a && typeof a.run === 'function' && typeof a.steer === 'function' && typeof a.isRunning === 'boolean';
}

export function createDaemon({ agent, handler, sources = [], signal, onAction, logger } = {}) {
  if (!isAgentLike(agent)) throw new ConfigError('createDaemon requires an Agent-like object');
  if (typeof handler !== 'function') throw new ConfigError('createDaemon requires handler to be a function');
  const componentLogger = resolveLogger(logger).child({ component: 'daemon' });
  const allSources = Array.isArray(sources) ? sources : [];

  let controller = null;
  let consumerAbortHandler = null;
  let started = false;
  let runController = null;

  const queue = [];
  let draining = false;
  let warnedCap = false;

  function emit(event) {
    if (!started) {
      componentLogger.warn({ eventType: event?.type }, 'Daemon ignored an event emitted before start');
      return;
    }
    queue.push({ ...event, receivedAt: Date.now() });
    if (queue.length > SOFT_CAP && !warnedCap) {
      warnedCap = true;
      componentLogger.warn(
        { softCap: SOFT_CAP, queueLength: queue.length },
        'Queue exceeded soft cap; handler may be too slow',
      );
    }
    drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0) {
        const event = queue.shift();
        await dispatch(event);
        if (warnedCap && queue.length <= SOFT_CAP) warnedCap = false;
      }
    } finally {
      draining = false;
    }
  }

  async function dispatch(event) {
    let action;
    try {
      action = await handler(event, makeCtx());
    } catch (err) {
      componentLogger.warn({ error: err, eventType: event?.type }, 'Daemon handler failed');
      return;
    }
    if (action == null) return;
    if (typeof onAction === 'function') {
      try {
        onAction(action, event);
      } catch (err) {
        componentLogger.warn({ error: err }, 'Daemon onAction callback failed');
      }
    }
    try {
      executeAction(action);
    } catch (err) {
      componentLogger.warn({ error: err, actionType: action?.type }, 'Daemon action failed');
    }
  }

  function ensureRunController() {
    if (!runController || runController.signal.aborted) runController = new AbortController();
    return runController;
  }

  function startRun(prompt, notify) {
    const c = ensureRunController();
    Promise.resolve(agent.run(prompt, notify, { signal: c.signal })).catch((err) =>
      componentLogger.warn({ error: err }, 'Agent run rejected'),
    );
  }

  function executeAction(action) {
    switch (action.type) {
      case undefined:
      case 'ignore':
        return;
      case 'run':
        startRun(action.prompt, action.notify);
        return;
      case 'steer': {
        const ok = agent.steer(action.prompt);
        if (!ok) componentLogger.warn({}, 'Daemon could not steer an idle agent');
        return;
      }
      case 'prompt':
        if (agent.isRunning) agent.steer(action.text);
        else startRun(action.text);
        return;
      case 'abort':
        if (runController) runController.abort();
        return;
      default:
        componentLogger.warn({ actionType: action.type }, 'Daemon ignored an unknown action type');
    }
  }

  function makeCtx() {
    return {
      agent,
      get isRunning() {
        return agent.isRunning;
      },
      emit,
      daemon: api,
      signal: controller ? controller.signal : undefined,
    };
  }

  function start() {
    if (started) return controller.signal;
    controller = new AbortController();
    if (signal && signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    started = true;
    if (signal) {
      consumerAbortHandler = () => {
        stop();
      };
      signal.addEventListener('abort', consumerAbortHandler);
    }
    for (const src of allSources) {
      try {
        const r = src.start(emit);
        if (r && typeof r.then === 'function') {
          r.catch((err) => componentLogger.warn({ error: err }, 'Daemon source failed to start'));
        }
      } catch (err) {
        componentLogger.warn({ error: err }, 'Daemon source failed to start');
      }
    }
    return controller.signal;
  }

  async function stop({ abort = false } = {}) {
    if (!started) return;
    started = false;
    await Promise.all(
      allSources.map(async (src) => {
        try {
          await src.stop();
        } catch (err) {
          componentLogger.warn({ error: err }, 'Daemon source failed to stop');
        }
      }),
    );
    if (signal && consumerAbortHandler) {
      signal.removeEventListener('abort', consumerAbortHandler);
      consumerAbortHandler = null;
    }
    if (abort && runController) runController.abort();
    if (controller) controller.abort();
  }

  const api = {
    start,
    stop,
    emit,
    get isRunning() {
      return started;
    },
    get signal() {
      return controller ? controller.signal : null;
    },
  };
  return api;
}

export function createTimerSource({ intervalMs, event, immediate = false } = {}) {
  if (!(typeof intervalMs === 'number' && intervalMs > 0)) {
    throw new ConfigError('createTimerSource requires intervalMs to be a positive number');
  }
  if (event == null) throw new ConfigError('createTimerSource requires an event');
  const make = () => (typeof event === 'function' ? event() : event);
  let timer = null;
  return {
    start(emit) {
      if (immediate) emit(make());
      timer = setInterval(() => emit(make()), intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
