import { ConfigError } from './errors.js';

function isAgentLike(a) {
  return a && typeof a.run === 'function' && typeof a.steer === 'function' && typeof a.isRunning === 'boolean';
}

export function createDaemon({ agent, handler, signal } = {}) {
  if (!isAgentLike(agent)) throw new ConfigError('createDaemon: agent must be an Agent-like object');
  if (typeof handler !== 'function') throw new ConfigError('createDaemon: handler must be a function');

  let controller = null;
  let consumerAbortHandler = null;
  let started = false;

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
    return controller.signal;
  }

  async function stop() {
    if (!started) return;
    started = false;
    if (signal && consumerAbortHandler) {
      signal.removeEventListener('abort', consumerAbortHandler);
      consumerAbortHandler = null;
    }
    if (controller) controller.abort();
  }

  return {
    start,
    stop,
    get isRunning() {
      return started;
    },
    get signal() {
      return controller ? controller.signal : null;
    },
  };
}

// stub — replaced in Task 5
export function createTimerSource() {
  throw new ConfigError('createTimerSource: not implemented yet');
}
