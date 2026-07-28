import { AbortError } from './errors.js';
import { LIMITS } from './payload.js';

const CALLBACK_TIMEOUT_MS = 5000;

export function createAbortError(message, cause) {
  const error = new AbortError(message, { cause });
  error.aborted = true;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isNonRetryable(error) {
  return (
    error?.aborted ||
    error?.status === 501 ||
    (error?.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
  );
}

function waitForDelay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError('Retry aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError('Retry aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function notifyExhausted(onExhausted, logger) {
  if (!onExhausted) return;
  try {
    const callbackResult = onExhausted();
    if (callbackResult && typeof callbackResult.then === 'function') {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Retry exhaustion callback timed out')), CALLBACK_TIMEOUT_MS);
      });
      try {
        await Promise.race([callbackResult, timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    logger?.warn?.({ component: 'retry', error }, 'Retry exhaustion callback failed');
  }
}

export async function retry(operation, options = {}) {
  const {
    attempts = 5,
    baseDelayMs = LIMITS.retryBaseDelayMs,
    maxDelayMs = 60_000,
    signal,
    onExhausted,
    logger,
  } = options;
  if (signal?.aborted) throw createAbortError('Retry aborted');

  let delayMs = baseDelayMs;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && signal?.aborted) throw createAbortError('Retry aborted');
    try {
      return await operation();
    } catch (error) {
      if (isNonRetryable(error)) throw error;
      lastError = error;
      if (attempt < attempts - 1) {
        const jitteredDelay = delayMs * (0.8 + Math.random() * 0.4);
        await waitForDelay(Math.min(jitteredDelay, maxDelayMs), signal);
        delayMs = Math.min(delayMs * LIMITS.retryBackoffFactor, maxDelayMs);
      }
    }
  }

  await notifyExhausted(onExhausted, logger);
  throw lastError;
}
