import { ConfigError } from './errors.js';
import { logger } from './logger.js';

const SOFT_CAP = 1000;

function isAgentLike(a) {
  return a && typeof a.run === 'function' && typeof a.steer === 'function' && typeof a.isRunning === 'boolean';
}

export function createDaemon({ agent, handler, sources = [], signal, onAction } = {}) {
  if (!isAgentLike(agent)) throw new ConfigError('createDaemon: agent must be an Agent-like object');
  if (typeof handler !== 'function') throw new ConfigError('createDaemon: handler must be a function');
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
      logger.warn('daemon.emit called while not started; event ignored');
      return;
    }
    queue.push({ ...event, receivedAt: Date.now() });
    if (queue.length > SOFT_CAP && !warnedCap) {
      warnedCap = true;
      logger.warn(`daemon queue exceeded ${SOFT_CAP} pending events; handler may be too slow`);
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
      logger.warn(`daemon handler threw: ${err.message}`);
      return;
    }
    if (action == null) return;
    if (typeof onAction === 'function') {
      try {
        onAction(action, event);
      } catch (err) {
        logger.warn(`daemon onAction threw: ${err.message}`);
      }
    }
    try {
      executeAction(action);
    } catch (err) {
      logger.warn(`daemon action execution threw: ${err.message}`);
    }
  }

  function ensureRunController() {
    if (!runController || runController.signal.aborted) runController = new AbortController();
    return runController;
  }

  function startRun(prompt, notify) {
    const c = ensureRunController();
    Promise.resolve(agent.run(prompt, notify, { signal: c.signal })).catch((err) =>
      logger.warn(`daemon run rejected: ${err.message}`),
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
        if (!ok) logger.warn('daemon steer action while agent idle; no-op');
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
        logger.warn(`daemon unknown action type '${action.type}'; ignored`);
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
          r.catch((err) => logger.warn(`daemon source start rejected: ${err.message}`));
        }
      } catch (err) {
        logger.warn(`daemon source start threw: ${err.message}`);
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
          logger.warn(`daemon source stop threw: ${err.message}`);
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

// stub — replaced in Task 5
export function createTimerSource() {
  throw new ConfigError('createTimerSource: not implemented yet');
}
