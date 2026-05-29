import { withRetry, getDirname, CONSTANTS, ensureSafePath, payloadHasMultimodal, degradePayload } from './utils.js';
import { ToolRegistry } from '../registry/tool.js';
import { ApiError, ConfigError } from './errors.js';
import logger from './logger.js';
import config from '../config.js';
import skillRegistry from '../registry/skill.js';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { readFile, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const __dirname = getDirname(import.meta);

function resolveStoragePath(p) {
  if (!p || typeof p !== 'string') return null;
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(expanded);
}

function normalizePrompt(prompt) {
  return Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
}

const REQUEST_TIMEOUT = 120_000; // 2 minutes idle threshold

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
const DEFAULT_MAX_TURNS = 25;
const VALID_INJECTOR_SCOPES = new Set(['first-turn', 'per-turn']);

class Agent {
  #apiKey;
  #instructionCache;
  #injectors = { 'first-turn': [], 'per-turn': [] };
  #beforeRequestHooks = [];
  #running = false;
  #pending = [];
  #activeRunPromise = null;
  #multimodalUnsupported = false;
  #notifyCallbacks = new Set();
  #pendingRichCallIds = new Set();
  #richUserMsgIdx = -1;
  #bgExitListeners;
  #bgRawListeners;
  #pendingBgDrains;
  #wakeScheduled = false;
  #envInfo = [
    '',
    '',
    '# Environment',
    'You have been invoked in the following environment:',
    ` - Primary working directory: ${process.cwd()}`,
    ` - Is a git repository: ${!!fs.existsSync('.git')}`,
    ` - Platform: ${os.platform()}`,
    ` - Shell: ${process.env.SHELL || 'unknown'}`,
    ` - OS version: ${os.release()}`,
  ];

  constructor(options = {}) {
    const {
      apiKey,
      model,
      tools,
      order,
      only,
      provider,
      maxTokens,
      systemPrompt,
      maxTurns,
      effort,
      maxToolOutputChars,
      injectors,
      contextFiles,
      storagePaths,
      memoryDir,
      memoryTypes,
      isSubagent,
      restricted,
      temperature,
      topP,
      minP,
      topK,
      frequencyPenalty,
      presencePenalty,
      repetitionPenalty,
      seed,
      maxCompletionTokens,
      responseFormat,
      stop,
      reasoning,
      autoWake,
    } = options;

    this.restricted = restricted !== false;
    if (this.restricted === false) {
      logger.warn(
        'Agent constructed with restricted=false — security checks disabled (project-root boundary, Bash blocked-command list, env-var filtering). Use only in trusted contexts.',
      );
    }

    if (!apiKey && !config.API_KEY) {
      throw new ConfigError('OPENROUTER_API_KEY is required. Set it in .env or pass it as an option.');
    }
    this.#apiKey = apiKey || config.API_KEY;
    this.model = model;
    this.isSubagent = !!isSubagent;

    const resolvedOrder = order || provider?.order || config.ORDER;
    const resolvedOnly = only || provider?.only || config.ONLY;
    const resolvedAvoid = provider?.avoid || config.PROVIDER_AVOID;
    const resolvedSort = provider?.sort || config.PROVIDER_SORT;
    const resolvedAllowFallbacks =
      provider?.allowFallbacks !== undefined ? provider.allowFallbacks : config.PROVIDER_ALLOW_FALLBACKS;
    const resolvedRequireParameters =
      provider?.requireParameters !== undefined ? provider.requireParameters : config.PROVIDER_REQUIRE_PARAMETERS;
    const resolvedDataCollection =
      provider?.dataCollection !== undefined ? provider.dataCollection : config.PROVIDER_DATA_COLLECTION;

    this.provider = {
      order: resolvedOrder,
      only: resolvedOnly,
      avoid: resolvedAvoid,
      sort: resolvedSort,
      allowFallbacks: resolvedAllowFallbacks,
      requireParameters: resolvedRequireParameters,
      dataCollection: resolvedDataCollection,
    };

    this.messages = [];
    this.tools = tools || new ToolRegistry({ restricted: this.restricted });

    this.temperature =
      temperature !== undefined
        ? temperature
        : config.TEMPERATURE !== undefined
          ? parseFloat(config.TEMPERATURE)
          : undefined;
    this.topP = topP !== undefined ? topP : config.TOP_P !== undefined ? parseFloat(config.TOP_P) : undefined;
    this.minP = minP !== undefined ? minP : config.MIN_P !== undefined ? parseFloat(config.MIN_P) : undefined;
    this.topK = topK !== undefined ? topK : config.TOP_K !== undefined ? parseInt(config.TOP_K) : undefined;
    this.frequencyPenalty =
      frequencyPenalty !== undefined
        ? frequencyPenalty
        : config.FREQUENCY_PENALTY !== undefined
          ? parseFloat(config.FREQUENCY_PENALTY)
          : undefined;
    this.presencePenalty =
      presencePenalty !== undefined
        ? presencePenalty
        : config.PRESENCE_PENALTY !== undefined
          ? parseFloat(config.PRESENCE_PENALTY)
          : undefined;
    this.repetitionPenalty =
      repetitionPenalty !== undefined
        ? repetitionPenalty
        : config.REPETITION_PENALTY !== undefined
          ? parseFloat(config.REPETITION_PENALTY)
          : undefined;
    this.seed = seed !== undefined ? seed : config.SEED !== undefined ? parseInt(config.SEED) : undefined;

    const resolvedMaxCompletionTokens =
      maxCompletionTokens !== undefined ? maxCompletionTokens : config.MAX_COMPLETION_TOKENS;
    this.maxCompletionTokens =
      resolvedMaxCompletionTokens !== undefined ? parseInt(resolvedMaxCompletionTokens) : undefined;

    this.responseFormat = responseFormat;
    this.stop = stop;

    this.reasoning = undefined;
    if (reasoning && typeof reasoning === 'object') {
      this.reasoning = {
        effort: reasoning.effort !== undefined ? reasoning.effort : config.REASONING_EFFORT,
        maxTokens:
          reasoning.maxTokens !== undefined
            ? reasoning.maxTokens
            : config.REASONING_MAX_TOKENS !== undefined
              ? parseInt(config.REASONING_MAX_TOKENS)
              : undefined,
        exclude: reasoning.exclude !== undefined ? reasoning.exclude : config.REASONING_EXCLUDE,
        enabled: reasoning.enabled !== undefined ? reasoning.enabled : config.REASONING_ENABLED,
      };
    } else if (
      config.REASONING_EFFORT ||
      config.REASONING_MAX_TOKENS !== undefined ||
      config.REASONING_EXCLUDE !== undefined ||
      config.REASONING_ENABLED !== undefined
    ) {
      this.reasoning = {
        effort: config.REASONING_EFFORT,
        maxTokens: config.REASONING_MAX_TOKENS !== undefined ? parseInt(config.REASONING_MAX_TOKENS) : undefined,
        exclude: config.REASONING_EXCLUDE,
        enabled: config.REASONING_ENABLED,
      };
    }

    if (this.reasoning) {
      this.effort = effort || this.reasoning.effort || config.REASONING_EFFORT || 'high';
    } else {
      this.effort = effort || config.REASONING_EFFORT || 'high';
    }

    this.maxTokens = parseInt(maxTokens || config.MAX_TOKENS || 0) || undefined;
    this.usage = { cost: 0, tokens: 0 };
    this.subagents = new Map();
    this.fileState = new Map();
    this.backgroundJobs = new Map();
    this.#bgExitListeners = new Set();
    this.#bgRawListeners = new Set();
    this.#pendingBgDrains = [];
    this.currentTurn = 0;
    // Max request turns before forcing a break.
    // Set to 0 for unlimited (used by subagents via Delegate).
    if (maxTurns !== undefined) {
      this.maxTurns = maxTurns;
    } else if (config.MAX_TURNS !== undefined && config.MAX_TURNS !== '') {
      const parsed = parseInt(config.MAX_TURNS);
      this.maxTurns = Number.isNaN(parsed) ? DEFAULT_MAX_TURNS : parsed;
    } else {
      this.maxTurns = DEFAULT_MAX_TURNS;
    }
    this.maxToolOutputChars = maxToolOutputChars ?? CONSTANTS.MAX_TOOL_OUTPUT;
    this.autoWake = autoWake !== undefined ? !!autoWake : config.AUTO_WAKE === 'true' || config.AUTO_WAKE === '1';
    this.systemPrompt =
      systemPrompt ||
      (() => {
        let base = 'You are an interactive agent that helps users with software engineering tasks.';
        try {
          base = fs.readFileSync(path.join(__dirname, '..', '..', 'RULE.md'), 'utf8');
        } catch {
          logger.debug('No RULE.md found, using default instruction.');
        }

        return base;
      })();

    if (injectors?.date !== false) {
      this.registerInjector({ name: 'date', scope: 'per-turn', fn: defaultDateInjector });
    }

    if (injectors?.contextFiles !== false) {
      const files = Array.isArray(contextFiles) && contextFiles.length > 0 ? contextFiles : ['AGENT.md'];
      this.registerInjector({
        name: 'contextFiles',
        scope: 'first-turn',
        fn: contextFilesInjector(files, () => this.trustedPaths),
      });
    }

    const resolvedMemoryDir =
      resolveStoragePath(storagePaths?.memoryDir) ||
      resolveStoragePath(memoryDir) ||
      path.resolve('.openrouter/memory');
    const resolvedTmpDir = resolveStoragePath(storagePaths?.tmpDir) || null;

    this._memoryDir = resolvedMemoryDir;
    this._storageTmpDir = resolvedTmpDir;
    this._storagePaths = options.storagePaths ?? null;
    this._todoFile = resolvedTmpDir
      ? path.join(resolvedTmpDir, `todos-${Math.random().toString(36).slice(2, 7)}.json`)
      : path.join(process.cwd(), '.todos.json');

    const _projectRoot = path.resolve(process.cwd());
    this.trustedPaths = new Set();
    for (const dir of [resolvedMemoryDir, resolvedTmpDir].filter(Boolean)) {
      const rel = path.relative(_projectRoot, dir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) this.trustedPaths.add(dir);
    }

    this._memoryTypes = {
      user: 'Information about the user — role, goals, knowledge, preferences.',
      feedback: 'Guidance the user gave about how to approach work. Lead with the rule, include why and how to apply.',
      project: "Ongoing work context, decisions, deadlines that aren't derivable from code/git.",
      reference: 'Pointers to external systems — dashboards, tracker projects, channels.',
      ...(memoryTypes || {}),
    };

    if (injectors?.memoryIndex !== false) {
      this.registerInjector({
        name: 'memoryIndex',
        scope: 'first-turn',
        fn: memoryIndexInjector(
          () => this._memoryDir,
          () => this.trustedPaths,
        ),
      });
    }

    if (injectors?.memoryHint !== false) {
      this.registerInjector({
        name: 'memoryHint',
        scope: 'first-turn',
        fn: memoryHintInjector(
          () => this._memoryDir,
          () => this._memoryTypes,
        ),
      });
    }

    if (injectors?.skillList !== false) {
      this.registerInjector({ name: 'skillList', scope: 'first-turn', fn: skillListInjector });
    }
  }

  // Read-only API key — used by Delegate tool for sub-agents
  get apiKey() {
    return this.#apiKey;
  }

  // Whether a run loop is currently active.
  get isRunning() {
    return this.#running;
  }

  // Queue a prompt for the active run loop. Non-blocking; returns false when
  // idle (no loop to steer) or when the prompt is empty.
  steer(prompt) {
    if (!this.#running) return false;
    if (prompt == null || prompt === '') return false;
    if (Array.isArray(prompt) && prompt.length === 0) return false;
    this.#pending.push(normalizePrompt(prompt));
    return true;
  }

  onBackgroundExit(fn) {
    if (typeof fn !== 'function') throw new TypeError('onBackgroundExit expects a function');
    this.#bgExitListeners.add(fn);
    return () => this.#bgExitListeners.delete(fn);
  }

  _fireBackgroundExit(event) {
    for (const fn of this.#bgRawListeners) {
      try {
        fn(event);
      } catch (err) {
        logger.warn(`raw bg listener threw: ${err.message}`);
      }
    }
    if (this.isRunning) {
      this.#pendingBgDrains.push(event);
    } else {
      for (const fn of this.#bgExitListeners) {
        try {
          fn(event);
        } catch (err) {
          logger.warn(`onBackgroundExit listener threw: ${err.message}`);
        }
      }
    }
  }

  _onBackgroundExitRaw(fn) {
    if (typeof fn !== 'function') throw new TypeError('_onBackgroundExitRaw expects a function');
    this.#bgRawListeners.add(fn);
    return () => this.#bgRawListeners.delete(fn);
  }

  registerInjector({ name, scope, fn } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new ConfigError('Injector name must be a non-empty string');
    }
    if (!VALID_INJECTOR_SCOPES.has(scope)) {
      const valid = [...VALID_INJECTOR_SCOPES].join(', ');
      throw new ConfigError(`Injector scope must be one of: ${valid}. Got: ${String(scope)}`);
    }
    if (typeof fn !== 'function') {
      throw new ConfigError(`Injector '${name}' requires fn to be a function`);
    }
    const bucket = this.#injectors[scope];
    if (bucket.some((entry) => entry.name === name)) {
      throw new ConfigError(`Injector '${name}' is already registered in scope '${scope}'`);
    }
    bucket.push({ name, fn });
  }

  unregisterInjector(name) {
    for (const scope of VALID_INJECTOR_SCOPES) {
      const bucket = this.#injectors[scope];
      const idx = bucket.findIndex((entry) => entry.name === name);
      if (idx !== -1) bucket.splice(idx, 1);
    }
  }

  onBeforeRequest(fn) {
    if (typeof fn !== 'function') {
      throw new ConfigError('onBeforeRequest expects a function');
    }
    this.#beforeRequestHooks.push(fn);
    return () => {
      const idx = this.#beforeRequestHooks.indexOf(fn);
      if (idx !== -1) this.#beforeRequestHooks.splice(idx, 1);
    };
  }

  async #runInjectors(scope) {
    const bucket = this.#injectors[scope];
    const ctx = { messages: this.messages, usage: this.usage, turn: this.messages.length };
    const out = [];
    for (const entry of bucket) {
      let result;
      try {
        result = await entry.fn(ctx);
      } catch (err) {
        logger.warn(`Injector '${entry.name}' (${scope}) threw: ${err?.message || err}`);
        continue;
      }
      if (typeof result === 'string' && result.trim().length > 0) {
        out.push(result);
      }
    }
    return out;
  }

  async #broadcast(event) {
    const promises = [];
    for (const notify of this.#notifyCallbacks) {
      if (typeof notify === 'function') {
        promises.push(
          (async () => {
            try {
              await notify(event);
            } catch (err) {
              logger.debug('Notify callback error:', err.message);
            }
          })(),
        );
      }
    }
    await Promise.all(promises);
  }

  async #request(payload) {
    const controller = new AbortController();
    const idle = makeIdleTimer(REQUEST_TIMEOUT, controller);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/af-t/openrouter',
          'X-OpenRouter-Title': 'OpenRouter CLI Agent',
        },
        body: JSON.stringify({ ...payload, stream: false }),
        signal: controller.signal,
      });

      // connection established — reset idle clock for body read
      idle.reset();

      let responseBody = await res.text();
      try {
        responseBody = JSON.parse(responseBody);
      } catch {
        if (!res.ok) {
          throw new ApiError(`OpenRouter API error (${res.status})`, res.status, responseBody.slice(0, 500));
        }
        throw new Error(`Failed to parse OpenRouter response as JSON: ${responseBody.slice(0, 500)}`);
      }

      if (!res.ok) {
        throw new ApiError(
          responseBody?.error?.message || `OpenRouter API error (${res.status})`,
          res.status,
          responseBody,
        );
      }

      return responseBody;
    } finally {
      idle.clear();
    }
  }

  async #buildPayload() {
    const messagesCopy = [...this.messages];
    const messagesForPayload = messagesCopy.map((msg, idx) => {
      if (
        idx === messagesCopy.length - 1 &&
        msg.role === 'user' &&
        Array.isArray(msg.content) &&
        msg.content.length > 0
      ) {
        const contentCopy = msg.content.map((part, partIdx) => {
          if (partIdx === msg.content.length - 1) {
            return { ...part, cache_control: { type: 'ephemeral' } };
          }
          return part;
        });
        return { ...msg, content: contentCopy };
      }
      return msg;
    });

    if (!this.#instructionCache) {
      this.#instructionCache = this.systemPrompt + this.#envInfo.join('\n');
    }

    const payload = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: this.#instructionCache,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        ...messagesForPayload,
      ],
      tools: this.tools.getDefinitions(),
    };

    if (payload.tools.length === 0) delete payload.tools;

    if (this.temperature !== undefined) payload.temperature = this.temperature;
    if (this.topP !== undefined) payload.top_p = this.topP;
    if (this.minP !== undefined) payload.min_p = this.minP;
    if (this.topK !== undefined) payload.top_k = this.topK;
    if (this.frequencyPenalty !== undefined) payload.frequency_penalty = this.frequencyPenalty;
    if (this.presencePenalty !== undefined) payload.presence_penalty = this.presencePenalty;
    if (this.repetitionPenalty !== undefined) payload.repetition_penalty = this.repetitionPenalty;
    if (this.seed !== undefined) payload.seed = this.seed;
    if (this.responseFormat !== undefined) payload.response_format = this.responseFormat;
    if (this.stop !== undefined) payload.stop = this.stop;

    if (this.maxCompletionTokens !== undefined) {
      payload.max_completion_tokens = this.maxCompletionTokens;
    } else if (this.maxTokens !== undefined) {
      payload.max_tokens = this.maxTokens;
    }

    const reasoningPayload = {};
    if (this.reasoning) {
      if (this.reasoning.effort !== undefined) reasoningPayload.effort = this.reasoning.effort;
      if (this.reasoning.maxTokens !== undefined) reasoningPayload.max_tokens = this.reasoning.maxTokens;
      if (this.reasoning.exclude !== undefined) reasoningPayload.exclude = this.reasoning.exclude;
      if (this.reasoning.enabled !== undefined) reasoningPayload.enabled = this.reasoning.enabled;
    } else if (this.effort !== undefined) {
      reasoningPayload.effort = this.effort;
    }

    if (Object.keys(reasoningPayload).length > 0) {
      payload.reasoning = reasoningPayload;
    }

    const providerPayload = {};
    if (this.provider) {
      if (this.provider.order !== undefined) providerPayload.order = this.provider.order;
      if (this.provider.only !== undefined) providerPayload.only = this.provider.only;
      if (this.provider.avoid !== undefined) providerPayload.avoid = this.provider.avoid;
      if (this.provider.sort !== undefined) providerPayload.sort = this.provider.sort;
      if (this.provider.allowFallbacks !== undefined) providerPayload.allow_fallbacks = this.provider.allowFallbacks;
      if (this.provider.requireParameters !== undefined)
        providerPayload.require_parameters = this.provider.requireParameters;
      if (this.provider.dataCollection !== undefined) {
        providerPayload.data_collection = this.provider.dataCollection;
        providerPayload.dataCollection = this.provider.dataCollection;
      }
    }
    if (Object.keys(providerPayload).length > 0) {
      payload.provider = providerPayload;
    }

    for (const hook of this.#beforeRequestHooks) {
      await hook(payload);
    }

    return payload;
  }

  async #send(payload) {
    if (typeof this._sendForTest === 'function') {
      const stub = await this._sendForTest(payload);
      this.usage.cost += stub.usage?.cost || 0;
      this.usage.tokens += stub.usage?.total_tokens || 0;
      return stub;
    }
    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this.#request(payload);
    logger.debug(`Received response from LLM.`);

    this.usage.cost += response.usage?.cost || 0;
    this.usage.tokens += response.usage?.total_tokens || 0;

    return response;
  }

  async #sendStream(payload) {
    if (typeof this._sendForTest === 'function') {
      const stub = await this._sendForTest(payload);
      this.usage.cost += stub.usage?.cost || 0;
      this.usage.tokens += stub.usage?.total_tokens || 0;
      return stub;
    }
    const controller = new AbortController();
    const idle = makeIdleTimer(REQUEST_TIMEOUT, controller);

    let res;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/af-t/openrouter',
          'X-OpenRouter-Title': 'OpenRouter CLI Agent',
        },
        body: JSON.stringify({ ...payload, stream: true }),
        signal: controller.signal,
      });
    } catch (err) {
      idle.clear();
      throw err;
    }

    // connection established — reset idle clock before stream begins
    idle.reset();

    if (!res.ok) {
      idle.clear();
      let body;
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      throw new ApiError(body?.error?.message || `OpenRouter API error (${res.status})`, res.status, body);
    }

    let content = '';
    let reasoning = '';
    const tcMap = {};
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processChunk = (chunk) => {
      this.usage.cost += chunk.usage?.cost || 0;
      this.usage.tokens += chunk.usage?.total_tokens || 0;

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;

      const cd = delta.content || '';
      const rd = delta.reasoning || delta.reasoning_content || '';
      if (cd) content += cd;
      if (rd) reasoning += rd;

      for (const tc of delta.tool_calls || []) {
        if (!tcMap[tc.index]) {
          tcMap[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        }
        if (tc.function?.name) tcMap[tc.index].function.name += tc.function.name;
        if (tc.function?.arguments) tcMap[tc.index].function.arguments += tc.function.arguments;
      }
    };

    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) {
            const line = buffer.trim();
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data !== '[DONE]') {
                try {
                  const chunk = JSON.parse(data);
                  processChunk(chunk);
                } catch {}
              }
            }
          }
          break;
        }
        idle.reset(); // data arrived — reset idle clock
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break outer;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          processChunk(chunk);

          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            const cd = delta.content || '';
            const rd = delta.reasoning || '';
            if (cd || rd) {
              await this.#broadcast({
                content_delta: cd || null,
                content: content || null,
                reasoning_delta: rd || null,
                reasoning: reasoning || null,
              });
            }
          }
        }
      }
    } finally {
      idle.clear();
      reader.releaseLock();
      controller.abort();
    }

    const tool_calls = Object.keys(tcMap).length ? Object.values(tcMap) : undefined;
    if (tool_calls) {
      await this.#broadcast({ tool_calls });
    }

    return {
      choices: [{ message: { content: content || null, reasoning: reasoning || null, tool_calls } }],
    };
  }

  async #executeOneToolCall(tc, signal) {
    const name = tc.function.name;
    const tool_call_id = tc.id || `call_${crypto.randomUUID()}`;
    let input;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch (parseErr) {
      logger.warn(`Agent: failed to parse tool arguments for "${name}": ${parseErr.message}`);
      throw new Error(`invalid JSON arguments — ${parseErr.message}`, { cause: parseErr });
    }

    await this.#broadcast({ tool_start: { tool_call_id, name, input } });

    logger.debug('Agent: Executing tool:', name);
    const started = Date.now();
    let output;
    let toolError;
    const richParts = [];
    try {
      const result = await this.tools.execute(name, input, { agent: this, signal });
      if (Array.isArray(result)) {
        // Extract any non-text parts (multimodal blocks like image_url, file)
        const textParts = [];
        for (const part of result) {
          if (part && typeof part === 'object') {
            if (part.type === 'text') {
              textParts.push(part.text);
            } else if (part.type !== undefined) {
              if (this.#multimodalUnsupported) {
                // model cannot handle rich content — note it in text instead
              } else {
                richParts.push(part);
              }
            } else {
              // fallback if it doesn't have a type property
              textParts.push(JSON.stringify(part));
            }
          } else {
            textParts.push(String(part));
          }
        }
        if (richParts.length > 0) {
          output = textParts.join('\n') || `[File loaded successfully as multimodal content]`;
        } else if (
          this.#multimodalUnsupported &&
          result.some((p) => p && typeof p === 'object' && p.type && p.type !== 'text')
        ) {
          output =
            (textParts.join('\n') || '') +
            '\n[Multimodal content not displayed — this model does not support it. Do not attempt to describe or guess the content.]';
        } else {
          output = result.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
        }
      } else if (result && typeof result === 'object' && result.type) {
        if (result.type === 'text') {
          output = result.text;
        } else if (this.#multimodalUnsupported) {
          output =
            '[Multimodal content not displayed — this model does not support it. Do not attempt to describe or guess the content.]';
        } else {
          richParts.push(result);
          output = `[File loaded successfully as multimodal content]`;
        }
      } else {
        output = typeof result === 'string' ? result : JSON.stringify(result);
      }
    } catch (err) {
      toolError = err;
    }
    const duration_ms = Date.now() - started;

    const payload = { tool_call_id, name, duration_ms };
    if (toolError) payload.error = toolError.message;
    else payload.output = output;

    await this.#broadcast({ tool_end: payload });

    if (toolError) throw toolError;
    return { output, richParts };
  }

  #injectBlock(block) {
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg?.role === 'user' && Array.isArray(lastMsg?.content) && lastMsg.content.length > 0) {
      lastMsg.content.splice(lastMsg.content.length - 1, 0, { type: 'text', text: block });
    }
  }

  #appendUserContent(parts) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content)) {
      last.content.push(...parts);
    } else {
      this.messages.push({ role: 'user', content: parts });
    }
  }

  // Fold queued bg-exit events into a single trailing user message.
  #drainBgExits() {
    if (this.#pendingBgDrains.length === 0) return;
    const events = this.#pendingBgDrains.splice(0);
    const lines = events.map(
      (e) =>
        `- ${e.id} (${e.kind}): ${e.status}, exit ${e.exitCode}, ${Math.round(e.durationMs / 100) / 10}s, log: ${e.logPath}`,
    );
    const text = `<system-reminder>\nBackground job(s) exited:\n${lines.join('\n')}\n</system-reminder>`;
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  // Flush queued steer prompts into messages as a trailing user message.
  async #drainPending() {
    if (this.#pending.length === 0) return false;
    const items = this.#pending.splice(0, this.#pending.length);
    for (const parts of items) this.#appendUserContent(parts);
    await this.#broadcast({ steer_applied: { count: items.length } });
    return true;
  }

  use(tools) {
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        this.tools.register(tool);
      }
      return;
    }
    this.tools.register(tools);
  }

  reset() {
    this.messages = [];
    this.usage = { cost: 0, tokens: 0 };
    this.fileState.clear();
    this.currentTurn = 0;
    this.#pendingRichCallIds = new Set();
    this.#richUserMsgIdx = -1;
    this.#multimodalUnsupported = false;
  }

  _scheduleTimer({ durationMs, watch = [], tailBytes = 4096 }) {
    const id = 'bg-' + crypto.randomBytes(4).toString('hex').slice(0, 5);
    const job = {
      id,
      kind: 'timer',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      logPath: null,
      watch,
      tailBytes,
      timer: null,
    };
    job.timer = setTimeout(() => {
      job.endedAt = Date.now();
      job.status = 'done';
      job.exitCode = 0;
      this._fireBackgroundExit({
        id,
        kind: 'timer',
        status: 'done',
        exitCode: 0,
        durationMs: job.endedAt - job.startedAt,
        logPath: null,
        watch,
        tailBytes,
      });
    }, durationMs);
    this.backgroundJobs.set(id, job);
    return { id };
  }

  _resolveBackgroundLogDir() {
    if (this._bgLogDir) return this._bgLogDir;
    let dir;
    if (this._storageTmpDir) {
      dir = this._storageTmpDir;
    } else {
      dir = path.join(os.tmpdir(), `openrouter-${process.pid}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync(dir);
    if (!this.trustedPaths.has(real)) this.trustedPaths.add(real);
    this._bgLogDir = real;
    return real;
  }

  async cleanup() {
    const SIGKILL_GRACE_MS = 2000;
    const killing = [];
    for (const job of this.backgroundJobs.values()) {
      if (job.status !== 'running') continue;
      if (job.kind === 'timer') {
        if (job.timer) clearTimeout(job.timer);
        job.status = 'killed';
        continue;
      }
      const child = job.child;
      if (child && typeof child.kill === 'function') {
        try {
          child.kill('SIGTERM');
        } catch {}
        killing.push(
          new Promise((resolve) => {
            const t = setTimeout(() => {
              try {
                child.kill('SIGKILL');
              } catch {}
              resolve();
            }, SIGKILL_GRACE_MS);
            const onExit = () => {
              clearTimeout(t);
              resolve();
            };
            if (child.on) child.on('exit', onExit);
            else if (child.onExit) child.onExit(onExit);
          }),
        );
      }
      job.status = 'killed';
    }
    await Promise.all(killing);

    if (this._storageTmpDir) {
      let entries;
      try {
        entries = await readdir(this._storageTmpDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        try {
          await unlink(path.join(this._storageTmpDir, entry.name));
        } catch (err) {
          logger.debug(`cleanup: failed to delete ${entry.name}: ${err.message}`);
        }
      }
    } else if (this._bgLogDir) {
      // auto-created fallback dir; remove entirely
      try {
        await rm(this._bgLogDir, { recursive: true, force: true });
      } catch (err) {
        logger.debug(`cleanup: failed to remove bg log dir: ${err.message}`);
      }
    }

    if (this.tools && typeof this.tools.cleanup === 'function') {
      try {
        await this.tools.cleanup();
      } catch (err) {
        logger.warn(`Failed to cleanup tools registry: ${err.message}`);
      }
    }

    if (this.subagents) {
      for (const [id, subagent] of this.subagents) {
        try {
          await subagent.cleanup();
        } catch (err) {
          logger.warn(`Failed to cleanup subagent ${id}: ${err.message}`);
        }
      }
      this.subagents.clear();
    }
  }

  async #runLoop(prompt, options = {}) {
    try {
      const { signal } = options;
      const isStreaming = this.#notifyCallbacks.size > 0;

      // freeze before prompt append
      const wasFresh = this.messages.length < 1;

      if (prompt) {
        this.#appendUserContent(normalizePrompt(prompt));
      }

      let loopCount = 0;

      while (true) {
        // Check abort signal
        if (signal?.aborted) {
          throw new Error('Agent run aborted');
        }

        if (this.maxTurns > 0 && loopCount >= this.maxTurns) {
          logger.warn(`Agent: max request turns reached (${this.maxTurns}), forcing break.`);
          if (this.isSubagent) {
            const lastMsg = this.messages[this.messages.length - 1];
            if (lastMsg?.role === 'tool') {
              return `[LIMIT_REACHED] The agent reached its maximum turn limit (${this.maxTurns}). \nLast tool result: ${lastMsg.content}`;
            }
          }
          break;
        }
        loopCount++;
        this.currentTurn = loopCount;

        // subagent turn-limit: nudge final summary on last tool turn
        if (this.isSubagent && this.maxTurns > 0 && loopCount === this.maxTurns) {
          const lastMsg = this.messages[this.messages.length - 1];
          if (lastMsg?.role === 'tool') {
            lastMsg.content +=
              '\n\n[SYSTEM] You have reached the maximum allowed request turns. Please provide a final summary of your work now and stop calling tools.';
          }
        }

        const isFirstTurn = wasFresh && loopCount === 1;

        // First-turn output is persisted into this.messages (always visible in history).
        if (isFirstTurn) {
          const firstTurnOut = await this.#runInjectors('first-turn');
          const text = firstTurnOut.join('\n\n').trim();
          if (text.length > 0) {
            const block = `<system-reminder>\n${text}\n</system-reminder>`;
            this.#injectBlock(block);
          }
        }

        // Per-turn output is also persisted into this.messages so the conversation
        // history has consistent structure across turns, avoiding cache misses
        // when the user sends a new prompt in a subsequent run() call.
        // If the last message is not a user message (e.g. tool result), the block
        // is silently dropped.
        {
          const perTurnOut = await this.#runInjectors('per-turn');
          const text = perTurnOut.join('\n\n').trim();
          if (text.length > 0) {
            const block = `<system-reminder>\n${text}\n</system-reminder>`;
            this.#injectBlock(block);
          }
        }

        // Build payload + onBeforeRequest hooks ONCE per turn.
        // withRetry retries the network call only — injectors and hooks do not re-fire.
        const payload = await this.#buildPayload();
        if (this.#multimodalUnsupported) degradePayload(payload);
        let response;
        try {
          response = await withRetry(() => (isStreaming ? this.#sendStream(payload) : this.#send(payload)), 5);
          this.#pendingRichCallIds.clear();
          this.#richUserMsgIdx = -1;
        } catch (err) {
          const errMsg = String(err.message).toLowerCase();
          const isMultimodalError =
            err instanceof ApiError &&
            (err.status === 400 ||
              err.status === 402 ||
              errMsg.includes('balance') ||
              errMsg.includes('file') ||
              errMsg.includes('video'));

          if (isMultimodalError && !this.#multimodalUnsupported && payloadHasMultimodal(payload)) {
            logger.warn(
              `Request rejected with multimodal error (${err.status || err.message}); degrading and retrying text-only fallback.`,
            );
            this.#multimodalUnsupported = true;
            for (const msg of this.messages) {
              if (msg.role === 'tool' && this.#pendingRichCallIds.has(msg.tool_call_id)) {
                msg.content =
                  (msg.content ? msg.content + '\n' : '') +
                  '[Multimodal content could not be displayed — this model does not support it. Do not describe or guess this content.]';
              }
            }
            this.#pendingRichCallIds.clear();
            const richNotice =
              '[Multimodal content could not be displayed — this model does not support it. Do not describe or guess the content.]';
            if (this.#richUserMsgIdx >= 0) {
              this.messages[this.#richUserMsgIdx] = { role: 'user', content: richNotice };
              this.#richUserMsgIdx = -1;
            }
            degradePayload(payload);
            // degradePayload collapses the rich user message to its text intro — replace with honest notice
            for (const msg of payload.messages) {
              if (msg.role === 'user' && msg.content === 'Multimodal content from the previous tool results:') {
                msg.content = richNotice;
                break;
              }
            }
            response = await withRetry(() => (isStreaming ? this.#sendStream(payload) : this.#send(payload)), 5);
          } else {
            this.#pendingRichCallIds.clear();
            throw err;
          }
        }
        const message = response.choices?.[0]?.message;
        if (!message) {
          logger.warn('Agent: LLM returned no message in response. Breaking loop.');
          break;
        }

        const { content, tool_calls } = message;
        const reasoning = message.reasoning || message.reasoning_content || undefined;

        this.messages.push({ role: 'assistant', reasoning, content, tool_calls });

        if (!tool_calls || tool_calls.length === 0) {
          // A steer delivered during the final turn keeps the loop alive.
          if (await this.#drainPending()) continue;
          // Fold any late bg exits into messages before terminating.
          this.#drainBgExits();
          break;
        }

        const settled = await Promise.allSettled(tool_calls.map((tc) => this.#executeOneToolCall(tc, signal)));

        const richPartsOrdered = [];
        const richToolIds = [];
        for (let i = 0; i < tool_calls.length; i++) {
          const tc = tool_calls[i];
          const r = settled[i];
          const tool_call_id = tc.id || `call_${crypto.randomUUID()}`;
          if (r.status === 'fulfilled') {
            const { output, richParts } = r.value;
            this.messages.push({ role: 'tool', content: output, tool_call_id });
            if (richParts.length > 0) {
              richPartsOrdered.push(...richParts);
              richToolIds.push(tool_call_id);
            }
          } else {
            const summary = (r.reason?.message || '').split('\n')[0];
            logger.warn(`Tool ${tc.function.name} failed: ${summary}`);
            this.messages.push({
              role: 'tool',
              content: `Error: ${r.reason?.message ?? r.reason}`,
              tool_call_id,
            });
          }
        }
        if (richPartsOrdered.length > 0) {
          this.#richUserMsgIdx = this.messages.length;
          this.messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Multimodal content from the previous tool results:' },
              ...richPartsOrdered,
            ],
          });
          for (const id of richToolIds) this.#pendingRichCallIds.add(id);
        }

        if (signal?.aborted) {
          throw new Error('Agent run aborted');
        }

        // Fold bg exits that arrived during tool execution into messages.
        this.#drainBgExits();
        // Flush any steer queued during this turn's tool execution.
        await this.#drainPending();
      }

      return this.messages[this.messages.length - 1].content;
    } finally {
      this.#running = false;
    }
  }

  async run(prompt, notify = null, options = {}) {
    // Re-entrancy guard: a run() call made while a loop is active enqueues its
    // prompt for the active loop instead of starting a second one.
    if (this.#running) {
      if (prompt != null && prompt !== '') {
        this.#pending.push(normalizePrompt(prompt));
      }
      if (notify) {
        this.#notifyCallbacks.add(notify);
      }
      return this.#activeRunPromise;
    }
    this.#running = true;
    if (notify) {
      this.#notifyCallbacks.add(notify);
    }
    this.#activeRunPromise = this.#runLoop(prompt, options);
    try {
      return await this.#activeRunPromise;
    } finally {
      this.#running = false;
      this.#activeRunPromise = null;
      this.#notifyCallbacks.clear();
      // Safety net: preserve any prompt queued during an abnormal loop exit.
      await this.#drainPending();
    }
  }
}

function defaultDateInjector() {
  const now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return `Current date: ${date} ${time} UTC`;
}

function contextFilesInjector(filePaths, trustedPathsFn) {
  return async function () {
    const trustedPaths = trustedPathsFn?.() ?? new Set();
    const parts = [];
    for (const filePath of filePaths) {
      let resolved;
      try {
        resolved = ensureSafePath(filePath, trustedPaths);
      } catch {
        // Path traversal or outside root — skip silently.
        continue;
      }
      let content;
      try {
        content = await readFile(resolved, 'utf8');
      } catch {
        // File missing — skip silently.
        continue;
      }
      if (filePaths.length > 1) {
        const basename = path.basename(resolved);
        parts.push(`## ${basename}\n${content}`);
      } else {
        parts.push(content);
      }
    }
    return parts.join('\n\n');
  };
}

function memoryIndexInjector(memoryDirFn, trustedPathsFn) {
  return async function () {
    const memoryDir = memoryDirFn();
    const trustedPaths = trustedPathsFn?.() ?? new Set();
    let resolved;
    try {
      resolved = ensureSafePath(path.join(memoryDir, 'MEMORY.md'), trustedPaths);
    } catch {
      return '';
    }
    try {
      const content = await readFile(resolved, 'utf8');
      if (!content.trim()) return '';
      return `## Memory index\n${content}`;
    } catch {
      return '';
    }
  };
}

function memoryHintInjector(memoryDirFn, memoryTypesFn) {
  return function () {
    const memoryDir = memoryDirFn();
    const types = memoryTypesFn();
    const typeLines = Object.entries(types)
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join('\n');
    return [
      '## Memory system',
      `Memory files live at \`${memoryDir}/\`. Use Write/Read/Edit tools to manage them.`,
      '',
      '### Available types',
      typeLines,
      '',
      'You **MUST** load the `using-memory` skill (via the Skill tool with action="load",',
      'argument="using-memory") BEFORE the first memory write or update in this conversation,',
      'unless you have already loaded it. The skill defines file format, naming conventions,',
      'and the MEMORY.md index protocol — you are required to follow it exactly.',
    ].join('\n');
  };
}

async function skillListInjector() {
  try {
    await skillRegistry._ensureDiscovered();
  } catch (err) {
    logger.warn(`Skill discovery failed: ${err?.message || err}`);
    return '';
  }
  const skills = skillRegistry.skills;
  if (!skills || skills.size === 0) return '';
  const lines = [];
  for (const [name, skill] of skills) {
    const desc = (skill.description || '').trim();
    const truncated = desc.length > 120 ? desc.slice(0, 117) + '...' : desc;
    lines.push(`- ${name} — ${truncated}`);
  }
  if (lines.length === 0) return '';
  return (
    `## Available skills\n${lines.join('\n')}\n\n` +
    'When a skill is relevant to your current task, you **MUST** load it via the Skill tool ' +
    '(action="load", argument=<skill name>) and follow its instructions and conventions exactly. ' +
    'Do not invent alternative approaches or formats when a skill provides authoritative guidance ' +
    'for the task at hand. Skill bodies are the source of truth for their respective domains.'
  );
}

export default Agent;
