import { ApiError } from '../support/errors.js';
import { buildRequestHeaders, resolveApiDialect } from '../support/http.js';
import { resolveLogger } from '../support/logger.js';
import { degradePayload, hasMultimodalContent } from '../support/payload.js';
import { createAbortError, retry } from '../support/retry.js';
import { finalizeReasoningDetails, mergeReasoningDelta } from '../core/reasoning.js';

// A request is abandoned once this long passes without any byte arriving. The
// clock restarts when the connection opens and again on every streamed chunk,
// so a slow but live response is never cut off.
const IDLE_TIMEOUT_MS = 120_000;

// Error for a request that failed because the caller aborted the run.
// `.aborted = true` makes retry fail fast instead of retrying. `cause` keeps the
// error that was in flight when the abort was observed (often a real ApiError)
// so err.cause retains it for inspection.
export function callerAbortError(cause) {
  return createAbortError('Agent run aborted', cause);
}

// Compose the caller's signal with the idle-timeout controller so a caller abort
// cancels the in-flight request immediately.
function composeSignals(callerSignal, idleSignal) {
  return callerSignal ? AbortSignal.any([callerSignal, idleSignal]) : idleSignal;
}

// If the caller's signal is why this failed, report a fast-failing, retry-skipping
// abort error (keeping the original as .cause); otherwise report it unchanged.
function asCallerAbort(error, signal) {
  return signal?.aborted ? callerAbortError(error) : error;
}

function makeIdleTimer(ms, controller) {
  let timer = setTimeout(() => controller.abort(), ms);
  return {
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), ms);
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

// Providers reject rich content through an explicit 400, a 402 when a paid
// multimodal model is out of reach, or a message naming the offending part.
function rejectsRichContent(error) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 400 || error.status === 402) return true;
  const message = String(error.message).toLowerCase();
  return message.includes('balance') || message.includes('file') || message.includes('video');
}

function readUsage(usage) {
  return {
    cost: usage?.cost || 0,
    tokens: usage?.total_tokens || 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens || 0,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_write_tokens || 0,
  };
}

// The run loop works in camel case; `message` and `raw` stay in the provider's
// wire shape because they are replayed into history and session recordings.
export function normalizeModelResponse(raw, usage = readUsage(raw?.usage)) {
  const choice = raw?.choices?.[0];
  const message = choice?.message;
  return {
    message,
    finishReason: choice?.finish_reason,
    usage,
    reasoning: message?.reasoning || undefined,
    reasoningDetails: message?.reasoning_details || undefined,
    raw,
  };
}

export class RequestClient {
  #apiKey;
  #url;
  #model;
  #dialect;
  #transport;
  #logger;
  #retryOptions;

  constructor({ apiKey, baseUrl, model, transport, logger, retryOptions } = {}) {
    this.#apiKey = apiKey;
    this.#url = `${baseUrl}/chat/completions`;
    this.#model = model;
    this.#dialect = resolveApiDialect(baseUrl);
    // Resolved per call so a consumer that replaces globalThis.fetch after the
    // client was built is still honoured.
    this.#transport = transport ?? ((url, options) => globalThis.fetch(url, options));
    this.#logger = resolveLogger(logger);
    this.#retryOptions = retryOptions ?? {};
  }

  // Send one model request and return its normalized response. `onChunk` observes
  // streamed deltas; `onDegrade` is called with the stripped payload when the
  // provider refused its non-text parts, so the caller can mirror the loss.
  async request(payload, { signal, stream = false, onChunk, onDegrade } = {}) {
    try {
      return await this.#sendWithRetry(payload, { signal, stream, onChunk });
    } catch (error) {
      if (!rejectsRichContent(error) || !hasMultimodalContent(payload)) throw error;
      this.#logger.warn(
        { component: 'requestClient', status: error.status, error },
        'Multimodal request rejected; degrading and retrying text-only fallback',
      );
      degradePayload(payload);
      await onDegrade?.(payload);
      return await this.#sendWithRetry(payload, { signal, stream, onChunk });
    }
  }

  #sendWithRetry(payload, { signal, stream, onChunk }) {
    let attempt = 0;
    return retry(
      () => {
        attempt += 1;
        this.#logger.debug(
          { component: 'requestClient', model: this.#model, stream, attempt },
          'Sending model request',
        );
        return stream ? this.#sendStream(payload, { signal, onChunk }) : this.#sendJson(payload, { signal });
      },
      { ...this.#retryOptions, signal, logger: this.#logger },
    );
  }

  #headers() {
    return buildRequestHeaders({ apiKey: this.#apiKey, dialect: this.#dialect });
  }

  async #sendJson(payload, { signal }) {
    const controller = new AbortController();
    const idle = makeIdleTimer(IDLE_TIMEOUT_MS, controller);
    try {
      const response = await this.#transport(this.#url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({ ...payload, stream: false }),
        signal: composeSignals(signal, controller.signal),
      });

      // The body read receives a fresh idle interval after connection.
      idle.reset();

      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        if (!response.ok) {
          throw new ApiError(`OpenRouter API error (${response.status})`, {
            status: response.status,
            body: text.slice(0, 500),
          });
        }
        throw new Error(`Failed to parse OpenRouter response as JSON: ${text.slice(0, 500)}`);
      }

      if (!response.ok) {
        throw new ApiError(body?.error?.message || `OpenRouter API error (${response.status})`, {
          status: response.status,
          body,
        });
      }

      return normalizeModelResponse(body);
    } catch (error) {
      throw asCallerAbort(error, signal);
    } finally {
      idle.clear();
    }
  }

  async #sendStream(payload, { signal, onChunk }) {
    const controller = new AbortController();
    const idle = makeIdleTimer(IDLE_TIMEOUT_MS, controller);

    let response;
    try {
      response = await this.#transport(this.#url, {
        method: 'POST',
        headers: this.#headers(),
        // Ask for streamed usage so strict OpenAI-compatible servers report tokens.
        body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
        signal: composeSignals(signal, controller.signal),
      });
    } catch (error) {
      idle.clear();
      throw asCallerAbort(error, signal);
    }

    // The stream receives a fresh idle interval after connection.
    idle.reset();

    if (!response.ok) {
      idle.clear();
      let body;
      try {
        body = await response.json();
      } catch {
        body = {};
      }
      throw asCallerAbort(
        new ApiError(body?.error?.message || `OpenRouter API error (${response.status})`, {
          status: response.status,
          body,
        }),
        signal,
      );
    }

    const usage = { cost: 0, tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    let content = '';
    let reasoning = '';
    let reasoningDetails = [];
    let finishReason = null;
    const partialToolCalls = {};
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Fold one chunk into the running response. Returns the text this chunk
    // arrived when there is something to show, otherwise null.
    const readChunk = (chunk) => {
      const chunkUsage = readUsage(chunk.usage);
      usage.cost += chunkUsage.cost;
      usage.tokens += chunkUsage.tokens;
      usage.cachedTokens += chunkUsage.cachedTokens;
      usage.cacheWriteTokens += chunkUsage.cacheWriteTokens;

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return null;

      const chunkFinishReason = chunk.choices?.[0]?.finish_reason;
      if (chunkFinishReason) finishReason = chunkFinishReason;

      const contentDelta = delta.content || '';
      const reasoningDelta = delta.reasoning || '';
      if (contentDelta) content += contentDelta;
      if (reasoningDelta) reasoning += reasoningDelta;

      if (delta.reasoning_details) {
        const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [delta.reasoning_details];
        if (details.length) reasoningDetails = mergeReasoningDelta(reasoningDetails, details);
      }

      for (const call of delta.tool_calls || []) {
        if (!partialToolCalls[call.index]) {
          partialToolCalls[call.index] = { id: call.id, type: 'function', function: { name: '', arguments: '' } };
        }
        if (call.function?.name) partialToolCalls[call.index].function.name += call.function.name;
        if (call.function?.arguments) partialToolCalls[call.index].function.arguments += call.function.arguments;
      }

      if (!contentDelta && !reasoningDelta) return null;
      return { contentDelta, content, reasoningDelta, reasoning };
    };

    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const line = buffer.trim();
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data !== '[DONE]') {
              try {
                readChunk(JSON.parse(data));
              } catch {}
            }
          }
          break;
        }
        idle.reset(); // data arrived: restart the idle clock
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break outer;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          const observed = readChunk(chunk);
          if (observed && onChunk) await onChunk(observed);
        }
      }
    } catch (error) {
      throw asCallerAbort(error, signal);
    } finally {
      idle.clear();
      reader.releaseLock();
      controller.abort();
    }

    const toolCalls = Object.keys(partialToolCalls).length ? Object.values(partialToolCalls) : undefined;
    const raw = {
      choices: [
        {
          message: {
            content: content || null,
            reasoning: reasoning || null,
            reasoning_details: finalizeReasoningDetails(reasoningDetails),
            tool_calls: toolCalls,
          },
          finish_reason: finishReason,
        },
      ],
    };
    return normalizeModelResponse(raw, usage);
  }
}
