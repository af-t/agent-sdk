import {
  withRetry,
  getDirname,
  CONSTANTS,
  ensureSafePath,
  payloadHasMultimodal,
  degradePayload,
  resolveDialect,
  buildRequestHeaders,
  sanitizeAppName,
} from './utils.js';
import { mergeReasoningDelta, finalizeReasoningDetails, sanitizeAssistantReasoning } from './reasoning.js';
import { ToolRegistry } from '../registry/tool.js';
import { ApiError, ConfigError } from './errors.js';
import logger from './logger.js';
import { createSessionRecorder } from './session-recorder.js';
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

// Error for a request that failed because the caller aborted the run.
// `.aborted = true` makes withRetry fail fast instead of retrying.
function callerAbortError() {
  const err = new Error('Agent run aborted');
  err.aborted = true;
  return err;
}

const DEFAULT_MAX_TURNS = 25;
const BG_KILL_GRACE_MS = 2000;
const VALID_INJECTOR_SCOPES = new Set(['first-turn', 'per-turn']);

const DEFAULT_EMPTY_TURN_RETRIES = 2;
const MAX_STOP_RECOVERY = 8;
const DEFAULT_EMPTY_TURN_NUDGE =
  'Your previous turn produced reasoning but no response and no tool call. Provide your final answer now, or call a tool to proceed.';

class Agent {
  #apiKey;
  #baseUrl;
  #instructionCache;
  #injectors = { 'first-turn': [], 'per-turn': [] };
  #beforeRequestHooks = [];
  #running = false;
  #pending = [];
  #activeRunPromise = null;
  #multimodalUnsupported = false;
  #notifyCallbacks = new Set();
  #subscribedCallbacks = new Set();
  #pendingRichCallIds = new Set();
  #richUserMsgIdx = -1;
  #bgExitListeners;
  #bgRawListeners;
  #pendingBgDrains;
  #wakeScheduled = false;
  #recorder = null;
  #stopHooks = [];
  #recoveryHook = null;
  #stopAttempts = 0;
  #recordConfig = null;
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
      baseUrl,
      model,
      embeddingModel,
      tools,
      order,
      only,
      provider,
      systemPrompt,
      maxTurns,
      effort,
      maxToolOutputChars,
      injectors,
      contextFiles,
      storagePaths,
      appName,
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
      autoWakeNotify,
      autoWakeOptions,
      record,
      emptyTurnRecovery,
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
    this.#baseUrl = baseUrl || config.BASE_URL || 'https://openrouter.ai/api/v1';
    this.dialect = resolveDialect(this.#baseUrl);

    // Empty-turn recovery is a built-in stop hook (default on). It re-sends the
    // same payload (raw retry) then nudges, so a terminal turn that carried only
    // reasoning (content empty, no tool calls) does not silently end the run.
    let recoveryEnabled = true;
    let recoveryRetries = DEFAULT_EMPTY_TURN_RETRIES;
    let recoveryNudge = DEFAULT_EMPTY_TURN_NUDGE;
    if (emptyTurnRecovery === false) {
      recoveryEnabled = false;
    } else if (emptyTurnRecovery && typeof emptyTurnRecovery === 'object') {
      if (emptyTurnRecovery.enabled !== undefined) recoveryEnabled = !!emptyTurnRecovery.enabled;
      if (emptyTurnRecovery.retries !== undefined) recoveryRetries = parseInt(emptyTurnRecovery.retries);
      if (typeof emptyTurnRecovery.nudge === 'string' && emptyTurnRecovery.nudge.trim().length > 0) {
        recoveryNudge = emptyTurnRecovery.nudge;
      }
    } else if (emptyTurnRecovery === undefined) {
      if (config.EMPTY_TURN_RECOVERY !== undefined) recoveryEnabled = config.EMPTY_TURN_RECOVERY;
      if (config.EMPTY_TURN_RETRIES !== undefined) {
        const parsedRetries = parseInt(config.EMPTY_TURN_RETRIES);
        if (!Number.isNaN(parsedRetries)) recoveryRetries = parsedRetries;
      }
    }
    if (Number.isNaN(recoveryRetries) || recoveryRetries < 0) recoveryRetries = DEFAULT_EMPTY_TURN_RETRIES;
    this.#recoveryHook = recoveryEnabled
      ? makeEmptyTurnRecoveryHook({ retries: recoveryRetries, nudge: recoveryNudge })
      : null;
    this.model = model;
    this.embeddingModel = embeddingModel ?? config.EMBEDDING_MODEL ?? 'openai/text-embedding-3-small';
    this.isSubagent = !!isSubagent;

    const resolvedOrder = order || provider?.order || config.ORDER;
    const resolvedOnly = only || provider?.only || config.ONLY;
    const resolvedIgnore = provider?.ignore || provider?.avoid || config.PROVIDER_IGNORE || config.PROVIDER_AVOID;
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
      ignore: resolvedIgnore,
      avoid: resolvedIgnore,
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

    // Resolve effort parameter with proper fallback order (explicit reasoning.effort > explicit effort > config.REASONING_EFFORT > 'high')
    let resolvedEffort = config.REASONING_EFFORT;
    if (effort !== undefined) {
      resolvedEffort = effort;
    }
    if (reasoning && typeof reasoning === 'object' && reasoning.effort !== undefined) {
      resolvedEffort = reasoning.effort;
    }

    this.reasoning = undefined;
    if (reasoning && typeof reasoning === 'object') {
      this.reasoning = {
        effort: resolvedEffort !== undefined ? resolvedEffort : config.REASONING_EFFORT,
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
      resolvedEffort !== undefined ||
      config.REASONING_MAX_TOKENS !== undefined ||
      config.REASONING_EXCLUDE !== undefined ||
      config.REASONING_ENABLED !== undefined
    ) {
      this.reasoning = {
        effort: resolvedEffort,
        maxTokens: config.REASONING_MAX_TOKENS !== undefined ? parseInt(config.REASONING_MAX_TOKENS) : undefined,
        exclude: config.REASONING_EXCLUDE,
        enabled: config.REASONING_ENABLED,
      };
    }

    this.usage = { cost: 0, tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
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
    // Callback and options forwarded to run() during auto-wake invocations,
    // allowing callers to attach streaming/WebSocket/metadata tracking.
    this.autoWakeNotify = autoWakeNotify ?? null;
    this.autoWakeOptions = autoWakeOptions ?? {};

    if (record) {
      this.#recordConfig = this.#normalizeRecordConfig(record === true ? {} : record);
    }

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
      const files = Array.isArray(contextFiles) && contextFiles.length > 0 ? contextFiles : ['AGENTS.md'];
      this.registerInjector({
        name: 'contextFiles',
        scope: 'first-turn',
        fn: contextFilesInjector(files, () => this.trustedPaths),
      });
    }

    this.appName = sanitizeAppName(appName ?? config.APP_NAME ?? CONSTANTS.DEFAULT_APP_NAME);
    const resolvedMemoryDir = resolveStoragePath(storagePaths?.memoryDir) || path.resolve(`.${this.appName}/memory`);
    const resolvedTmpDir = resolveStoragePath(storagePaths?.tmpDir) || null;
    const resolvedPluginsDir = resolveStoragePath(storagePaths?.pluginsDir) || path.resolve(`.${this.appName}/plugins`);

    this._memoryDir = resolvedMemoryDir;
    this._storageTmpDir = resolvedTmpDir;
    this._pluginsDir = resolvedPluginsDir;
    this._storagePaths = options.storagePaths ?? null;
    this._todoFile = resolvedTmpDir
      ? path.join(resolvedTmpDir, `todos-${Math.random().toString(36).slice(2, 7)}.json`)
      : path.resolve(`.${this.appName}/todos.json`);

    // plugins feed skills and injector
    skillRegistry.configure({ pluginsDir: this._pluginsDir });

    const _projectRoot = path.resolve(process.cwd());
    this.trustedPaths = new Set();
    for (const dir of [resolvedMemoryDir, resolvedTmpDir, resolvedPluginsDir].filter(Boolean)) {
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
    if (injectors?.pluginInstructions !== false) {
      this.registerInjector({ name: 'pluginInstructions', scope: 'first-turn', fn: pluginInstructionsInjector });
    }
  }

  // Shorthand/compatibility getter and setter for reasoning effort
  get effort() {
    return this.reasoning?.effort ?? config.REASONING_EFFORT ?? 'high';
  }

  set effort(val) {
    if (!this.reasoning) {
      this.reasoning = {
        effort: val,
        maxTokens: undefined,
        exclude: undefined,
        enabled: undefined,
      };
    } else {
      this.reasoning.effort = val;
    }
  }

  // Read-only API key — used by Delegate tool for sub-agents
  get apiKey() {
    return this.#apiKey;
  }

  get baseUrl() {
    return this.#baseUrl;
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

  // Rebuild an Agent that re-drives a recorded run with no network calls.
  // Each turn's transport yields the recorded response via the _sendForTest
  // seam. toolMode 'replay' (default) returns recorded tool outputs (no side
  // effects re-run); 'live' re-executes the provided tools for real.
  static replay(recording, { tools, toolMode = 'replay' } = {}) {
    if (!recording || recording.level !== 'full') {
      throw new Error("Agent.replay requires a 'full'-level recording (record at level 'full' to capture responses)");
    }
    if (toolMode !== 'replay' && toolMode !== 'live') {
      throw new Error(`Agent.replay: unknown toolMode '${toolMode}' (expected 'replay' or 'live')`);
    }
    const agent = new Agent({
      apiKey: 'replay',
      model: recording.model,
      tools,
      maxTurns: 0,
      injectors: {
        date: false,
        contextFiles: false,
        memoryIndex: false,
        memoryHint: false,
        skillList: false,
        pluginInstructions: false,
      },
    });

    // return the recorded response for the turn the loop is on
    agent._sendForTest = async () => {
      const raw = recording.responseAt(agent.currentTurn);
      if (!raw) {
        // tag non-retryable so withRetry fails fast
        const err = new Error(`replay: no recorded response for turn ${agent.currentTurn}`);
        err.status = 400;
        throw err;
      }
      return raw;
    };

    if (toolMode === 'replay') {
      // stub any recorded tool the registry lacks, so execute()
      // finds a tool before the override hook supplies its output
      const known = new Set(agent.tools.listTools().map((t) => t.name));
      for (const ev of recording.events) {
        if (ev.type !== 'tool_calls') continue;
        for (const c of ev.calls) {
          if (known.has(c.name)) continue;
          agent.tools.register({
            name: c.name,
            description: 'replay stub',
            input_schema: { type: 'object', properties: {} },
            execute: async () => '',
          });
          known.add(c.name);
        }
      }
      // short-circuit each tool with its recorded output, by call id
      agent.tools.onBeforeExecute(({ context }) => {
        const rec = recording.toolResult(context?.tool_call_id);
        if (!rec) return;
        if (rec.error !== undefined) throw new Error(rec.error);
        return { override: rec.output };
      });
    }

    return agent;
  }

  forkAt(recording, turn) {
    const snap = recording.snapshotAt(turn);
    if (!snap) {
      throw new Error(`No snapshot at turn ${turn} (record at level 'snapshots' or 'full' to enable forking)`);
    }
    // forward read-only pluginsDir only
    // the fork does not inherit recording
    const child = new Agent({
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      model: this.model,
      tools: this.tools,
      restricted: this.restricted,
      systemPrompt: this.systemPrompt,
      maxTurns: this.maxTurns,
      appName: this.appName,
      storagePaths: { pluginsDir: this._pluginsDir },
    });
    // keep in sync with sampling params in constructor
    const carry = [
      'temperature',
      'topP',
      'minP',
      'topK',
      'frequencyPenalty',
      'presencePenalty',
      'repetitionPenalty',
      'seed',
      'maxCompletionTokens',
      'responseFormat',
      'stop',
      'effort',
      'autoWake',
      'embeddingModel',
      'maxToolOutputChars',
    ];
    for (const k of carry) child[k] = this[k];
    child.reasoning = this.reasoning ? { ...this.reasoning } : undefined;
    child.provider = { ...this.provider };
    child.messages = structuredClone(snap.messages);
    child.usage = { ...snap.usage };
    return child;
  }

  startRecording(opts = {}) {
    if (this.#recorder) this.#recorder.close().catch(() => {});
    this.#recordConfig = this.#normalizeRecordConfig(opts);
    this.#recorder = createSessionRecorder({ ...this.#recordConfig, model: this.model });
    return this.#recorder.path;
  }

  async stopRecording() {
    if (!this.#recorder) return null;
    const p = this.#recorder.path;
    try {
      await this.#recorder.close();
    } catch (err) {
      logger.warn(`Failed to close session recorder: ${err.message}`);
    }
    this.#recorder = null;
    this.#recordConfig = null;
    return p;
  }

  onBackgroundExit(fn) {
    if (typeof fn !== 'function') throw new TypeError('onBackgroundExit expects a function');
    this.#bgExitListeners.add(fn);
    return () => this.#bgExitListeners.delete(fn);
  }

  // Persistent event listener, independent of run(). Returns a disposer.
  // Note: an active subscription makes #subscribedCallbacks non-empty, so run()
  // selects the SSE streaming transport for its duration (intended).
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
    this.#subscribedCallbacks.add(fn);
    return () => this.#subscribedCallbacks.delete(fn);
  }

  _fireBackgroundExit(event) {
    for (const fn of this.#bgRawListeners) {
      try {
        fn(event);
      } catch (err) {
        logger.warn(`raw bg listener threw: ${err.message}`);
      }
    }

    // Always record the exit event regardless of autoWake setting.
    // This decouples reminder draining from the autoWake option so that
    // callers who disable autoWake can still manually call run() and get
    // the reminder messages via #drainBgExits (fixes coupled-reminder bug).
    this.#pendingBgDrains.push(event);

    if (this.isRunning) {
      // The active run loop will drain #pendingBgDrains at the end of
      // each tool-execution turn and before termination.
      return;
    }

    // Notify external listeners (only when idle — during a run these are
    // deferred until the run completes).
    for (const fn of this.#bgExitListeners) {
      try {
        fn(event);
      } catch (err) {
        logger.warn(`onBackgroundExit listener threw: ${err.message}`);
      }
    }

    this.#triggerAutoWake();
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

  // Register a stop hook. Hooks fire on a terminal (no-tool_calls) turn and may
  // return { action: 'stop' } | undefined (allow stop), { action: 'retry' }
  // (re-send the same payload), or { action: 'continue', prompt } (inject a
  // user nudge and keep looping). User hooks run before the built-in recovery
  // hook; the first non-stop decision wins. Returns a disposer.
  onStop(fn) {
    if (typeof fn !== 'function') {
      throw new ConfigError('onStop expects a function');
    }
    this.#stopHooks.push(fn);
    return () => {
      const idx = this.#stopHooks.indexOf(fn);
      if (idx !== -1) this.#stopHooks.splice(idx, 1);
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

  #normalizeRecordConfig(opts = {}) {
    return {
      dir: opts.dir ? path.resolve(opts.dir) : path.resolve(`.${this.appName}/sessions`),
      level: opts.level || 'snapshots',
      redact: typeof opts.redact === 'function' ? opts.redact : undefined,
    };
  }

  #maybeStartRecorder() {
    if (!this.#recordConfig || this.#recorder) return;
    try {
      this.#recorder = createSessionRecorder({ ...this.#recordConfig, model: this.model });
    } catch (err) {
      logger.warn(`Failed to start session recorder: ${err.message}`);
      this.#recordConfig = null;
    }
  }

  async #broadcast(event) {
    this.#recorder?.record(event, this.currentTurn);
    const promises = [];
    const targets =
      event && event.turn_end
        ? this.#subscribedCallbacks
        : new Set([...this.#notifyCallbacks, ...this.#subscribedCallbacks]);
    for (const notify of targets) {
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

  async #request(payload, signal) {
    const controller = new AbortController();
    const idle = makeIdleTimer(REQUEST_TIMEOUT, controller);
    // Compose the caller's signal with the idle-timeout controller so a
    // caller abort cancels the in-flight fetch immediately.
    const fetchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildRequestHeaders({ apiKey: this.#apiKey, dialect: this.dialect }),
        body: JSON.stringify({ ...payload, stream: false }),
        signal: fetchSignal,
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
    } catch (err) {
      if (signal?.aborted) throw callerAbortError();
      throw err;
    } finally {
      idle.clear();
    }
  }

  // Run stop hooks in order (user hooks first, then the built-in recovery hook).
  // The first decision whose action is not 'stop' wins.
  async #runStopHooks(ctx) {
    const hooks = this.#recoveryHook ? [...this.#stopHooks, this.#recoveryHook] : this.#stopHooks;
    for (const fn of hooks) {
      let decision;
      try {
        decision = await fn(ctx);
      } catch (err) {
        logger.warn(`Stop hook threw: ${err?.message || err}`);
        continue;
      }
      if (decision && decision.action && decision.action !== 'stop') {
        return decision;
      }
    }
    return undefined;
  }

  // Resolve a terminal (no-tool_calls) turn via stop hooks. May re-send the same
  // payload (raw retry) and re-evaluate, request a nudge, or allow the stop. It
  // never commits an assistant message — the caller decides based on the result.
  // Returns { continue: true, prompt } for a nudge, otherwise
  // { content, reasoning, tool_calls, finish_reason } to adopt.
  async #resolveStop({ payload, isStreaming, signal, turn, content, reasoning, reasoning_details, finish_reason }) {
    let tool_calls;
    let lastError;
    while (true) {
      // Abort observed between retries: stop issuing new ones and terminate with
      // the current message. Mirrors the run loop's between-turns signal check, so
      // recovery never extends stop latency past a single in-flight REQUEST_TIMEOUT.
      if (signal?.aborted) {
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }

      if (this.#stopAttempts > MAX_STOP_RECOVERY) {
        logger.warn(`Agent: stop-recovery ceiling (${MAX_STOP_RECOVERY}) reached; forcing stop.`);
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }

      const decision = await this.#runStopHooks({
        content,
        reasoning,
        finish_reason,
        turn,
        attempt: this.#stopAttempts,
        usage: this.usage,
        messages: this.messages,
        lastError,
      });
      const action = decision?.action ?? 'stop';

      if (action === 'continue') {
        this.#stopAttempts++;
        return { continue: true, prompt: decision.prompt };
      }

      if (action !== 'retry') {
        // 'stop' or unknown — allow termination with the current message.
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }

      // action === 'retry': re-send the identical payload.
      this.#stopAttempts++;
      try {
        const retryResponse = await withRetry(
          () => (isStreaming ? this.#sendStream(payload, signal) : this.#send(payload, signal)),
          5,
        );
        const retryMessage = retryResponse.choices?.[0]?.message;
        content = retryMessage?.content || null;
        reasoning = retryMessage?.reasoning || undefined;
        reasoning_details = retryMessage?.reasoning_details || undefined;
        tool_calls = retryMessage?.tool_calls || null;
        finish_reason = retryResponse.choices?.[0]?.finish_reason;
        lastError = null;
      } catch (err) {
        // A failed raw retry (incl. a hard 4xx like a history-schema 400) leaves
        // content empty and is surfaced via lastError; the recovery hook keys off
        // lastError to escalate straight to the nudge on the next iteration.
        lastError = err;
      }

      const recovered = tool_calls && tool_calls.length > 0;
      if (recovered) {
        this.#stopAttempts = 0;
        return { content, reasoning, reasoning_details, tool_calls, finish_reason };
      }
      // still empty — loop and re-evaluate hooks with the incremented attempt
    }
  }

  async #buildPayload() {
    const isOpenAI = this.dialect === 'openai';
    const messagesCopy = [...this.messages];
    const messagesForPayload = messagesCopy.map((msg, idx) => {
      // NOTE: Caching is intentionally only placed on the last 'user' role message
      // to follow standard Anthropic messages format guidelines and prevent caching logic complexity.
      if (
        !isOpenAI &&
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
      if (msg.role === 'assistant') {
        return sanitizeAssistantReasoning(msg, this.dialect);
      }
      // Tool messages carry internal history/UI metadata (duration_ms) that must
      // not reach the provider. Rebuild the exact wire shape rather than clone +
      // delete (which deopts V8 to dictionary mode), so no internal field leaks.
      if (msg.role === 'tool') {
        return { role: 'tool', content: msg.content, tool_call_id: msg.tool_call_id };
      }
      return msg;
    });

    if (!this.#instructionCache) {
      this.#instructionCache = this.systemPrompt + this.#envInfo.join('\n');
    }

    const systemTextPart = { type: 'text', text: this.#instructionCache };
    if (!isOpenAI) systemTextPart.cache_control = { type: 'ephemeral' };

    const payload = {
      model: this.model,
      messages: [{ role: 'system', content: [systemTextPart] }, ...messagesForPayload],
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
    }

    if (isOpenAI) {
      const effort = this.effort;
      if (effort !== undefined) payload.reasoning_effort = effort;
    } else {
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
        // Wire field is `ignore` per OpenRouter provider docs
        const ignoreVal = this.provider.ignore !== undefined ? this.provider.ignore : this.provider.avoid;
        if (ignoreVal !== undefined) providerPayload.ignore = ignoreVal;
        if (this.provider.sort !== undefined) providerPayload.sort = this.provider.sort;
        if (this.provider.allowFallbacks !== undefined) providerPayload.allow_fallbacks = this.provider.allowFallbacks;
        if (this.provider.requireParameters !== undefined)
          providerPayload.require_parameters = this.provider.requireParameters;
        if (this.provider.dataCollection !== undefined) {
          providerPayload.data_collection = this.provider.dataCollection;
        }
      }
      if (Object.keys(providerPayload).length > 0) {
        payload.provider = providerPayload;
      }
    }

    for (const hook of this.#beforeRequestHooks) {
      await hook(payload);
    }

    return payload;
  }

  async #sendTestStub(payload) {
    const stub = await this._sendForTest(payload);
    this.usage.cost += stub.usage?.cost || 0;
    this.usage.tokens += stub.usage?.total_tokens || 0;
    if (stub.usage?.prompt_tokens_details) {
      this.usage.cachedTokens += stub.usage.prompt_tokens_details.cached_tokens || 0;
      this.usage.cacheWriteTokens += stub.usage.prompt_tokens_details.cache_write_tokens || 0;
    }
    return stub;
  }

  async #send(payload, signal) {
    if (typeof this._sendForTest === 'function') {
      return this.#sendTestStub(payload);
    }
    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this.#request(payload, signal);
    logger.debug(`Received response from LLM.`);

    this.usage.cost += response.usage?.cost || 0;
    this.usage.tokens += response.usage?.total_tokens || 0;
    if (response.usage?.prompt_tokens_details) {
      this.usage.cachedTokens += response.usage.prompt_tokens_details.cached_tokens || 0;
      this.usage.cacheWriteTokens += response.usage.prompt_tokens_details.cache_write_tokens || 0;
    }

    return response;
  }

  async #sendStream(payload, signal) {
    if (typeof this._sendForTest === 'function') {
      return this.#sendTestStub(payload);
    }
    const controller = new AbortController();
    const idle = makeIdleTimer(REQUEST_TIMEOUT, controller);
    const fetchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

    let res;
    try {
      res = await fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildRequestHeaders({ apiKey: this.#apiKey, dialect: this.dialect }),
        // Request streamed usage so strict OpenAI-compatible servers report token usage.
        body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
        signal: fetchSignal,
      });
    } catch (err) {
      idle.clear();
      if (signal?.aborted) throw callerAbortError();
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
    let reasoningDetails = [];
    let finishReason = null;
    const tcMap = {};
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processChunk = (chunk) => {
      this.usage.cost += chunk.usage?.cost || 0;
      this.usage.tokens += chunk.usage?.total_tokens || 0;
      if (chunk.usage?.prompt_tokens_details) {
        this.usage.cachedTokens += chunk.usage.prompt_tokens_details.cached_tokens || 0;
        this.usage.cacheWriteTokens += chunk.usage.prompt_tokens_details.cache_write_tokens || 0;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;

      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) finishReason = fr;

      const cd = delta.content || '';
      const rd = delta.reasoning || '';
      if (cd) content += cd;
      if (rd) reasoning += rd;

      if (delta.reasoning_details) {
        const detailsArray = Array.isArray(delta.reasoning_details)
          ? delta.reasoning_details
          : [delta.reasoning_details];
        if (detailsArray.length) {
          reasoningDetails = mergeReasoningDelta(reasoningDetails, detailsArray);
        }
      }

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
    } catch (err) {
      if (signal?.aborted) throw callerAbortError();
      throw err;
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
      choices: [
        {
          message: {
            content: content || null,
            reasoning: reasoning || null,
            reasoning_details: finalizeReasoningDetails(reasoningDetails),
            tool_calls,
          },
          finish_reason: finishReason,
        },
      ],
    };
  }

  async #executeOneToolCall(tc, signal) {
    const name = tc.function.name;
    const tool_call_id = tc.id;
    let input;
    try {
      // Zero-parameter tools stream an empty arguments string; treat
      // empty/whitespace/missing as an empty object instead of failing.
      const rawArgs = tc.function.arguments;
      input = rawArgs && rawArgs.trim() ? JSON.parse(rawArgs.trim()) : {};
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
      const result = await this.tools.execute(name, input, { agent: this, signal, tool_call_id });
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

    if (toolError) {
      toolError.duration_ms = duration_ms;
      throw toolError;
    }
    return { output, richParts, duration_ms };
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

  // Fold queued bg-exit events into a trailing user message. Returns true when
  // something was drained. Routes through #appendUserContent so a drain at run
  // start merges into the fresh prompt instead of emitting a stray
  // user-after-user message.
  #drainBgExits() {
    if (this.#pendingBgDrains.length === 0) return false;
    const events = this.#pendingBgDrains.splice(0);
    const lines = [];
    for (const e of events) {
      lines.push(
        `- ${e.id} (${e.kind}): ${e.status}, exit ${e.exitCode}, ${Math.round(e.durationMs / 100) / 10}s, log: ${e.logPath}`,
      );
      if (Array.isArray(e.watch) && e.watch.length) {
        for (const wid of e.watch) lines.push(describeJob(this, wid, e.tailBytes ?? 4096));
      }
    }
    const text = `<system-reminder>\nBackground job(s) exited:\n${lines.join('\n')}\n</system-reminder>`;
    this.#appendUserContent([{ type: 'text', text }]);
    return true;
  }

  #triggerAutoWake() {
    if (this.autoWake && !this.#wakeScheduled) {
      this.#wakeScheduled = true;
      // Coalesce multiple rapid exits into a single wake-up by deferring
      // via queueMicrotask.  All events that arrive before the microtask
      // fires will be batched into #pendingBgDrains and drained together.
      queueMicrotask(() => {
        this.#wakeScheduled = false;
        if (this.#running) return; // a user-initiated run started in the meantime
        if (this.#pendingBgDrains.length === 0) return; // already consumed

        // Drain the queued events into messages *before* running so the
        // model sees the reminder on the very first turn of the wake-up.
        this.#drainBgExits();

        const notify = typeof this.autoWakeNotify === 'function' ? this.autoWakeNotify : null;
        this.run(null, notify, this.autoWakeOptions ?? {}).catch((err) =>
          logger.warn(`autoWake run failed: ${err.message}`),
        );
      });
    }
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
    this.usage = { cost: 0, tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
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

  // Stop one background job by id
  _killBackgroundJob(id) {
    const job = this.backgroundJobs?.get(id);
    if (!job) return { ok: false, status: 'not_found' };
    if (job.status !== 'running') return { ok: false, status: 'already_finished', jobStatus: job.status };

    if (job.kind === 'timer') {
      if (job.timer) clearTimeout(job.timer);
      job.endedAt = Date.now();
      job.status = 'killed';
      return { ok: true, kind: 'timer' };
    }

    if (job.kind === 'delegate') {
      try {
        job.controller?.abort();
      } catch {}
      job.status = 'killed';
      return { ok: true, kind: 'delegate' };
    }

    // bash: signal the real process; the exit handler finalizes status
    const child = job.child;
    if (child && typeof child.kill === 'function') {
      try {
        child.kill('SIGTERM');
      } catch {}
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, BG_KILL_GRACE_MS);
      if (typeof t.unref === 'function') t.unref();
      const clear = () => clearTimeout(t);
      if (typeof child.on === 'function') child.on('exit', clear);
      else if (typeof child.onExit === 'function') child.onExit(clear);
    }
    job.status = 'killed';
    return { ok: true, kind: 'bash' };
  }

  _resolveBackgroundLogDir() {
    if (this._bgLogDir) return this._bgLogDir;
    let dir;
    if (this._storageTmpDir) {
      dir = this._storageTmpDir;
    } else {
      dir = path.join(os.tmpdir(), `${this.appName}-${process.pid}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync(dir);
    if (!this.trustedPaths.has(real)) this.trustedPaths.add(real);
    this._bgLogDir = real;
    return real;
  }

  async cleanup() {
    if (this.#recorder) {
      try {
        await this.#recorder.close();
      } catch (err) {
        logger.warn(`Failed to close session recorder: ${err.message}`);
      }
      this.#recorder = null;
      this.#recordConfig = null;
    }
    const killing = [];
    for (const job of this.backgroundJobs.values()) {
      if (job.status !== 'running') continue;
      if (job.kind === 'timer') {
        if (job.timer) clearTimeout(job.timer);
        job.status = 'killed';
        continue;
      }
      if (job.controller) {
        try {
          job.controller.abort();
        } catch {}
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
            }, BG_KILL_GRACE_MS);
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
      this.#maybeStartRecorder();
      const isStreaming = this.#notifyCallbacks.size > 0 || this.#subscribedCallbacks.size > 0;

      // freeze before prompt append
      const wasFresh = this.messages.length < 1;

      if (prompt) {
        this.#appendUserContent(normalizePrompt(prompt));
      }

      // Surface background-exit reminders that queued while idle so the model
      // sees them on the first turn (merged with the prompt) instead of only
      // after the first tool group. Late exits during the run still drain at
      // tool boundaries / termination below.
      this.#drainBgExits();

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
        this.#recorder?.request(loopCount, payload);
        let response;
        try {
          response = await withRetry(
            () => (isStreaming ? this.#sendStream(payload, signal) : this.#send(payload, signal)),
            5,
          );
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
            response = await withRetry(
              () => (isStreaming ? this.#sendStream(payload, signal) : this.#send(payload, signal)),
              5,
            );
          } else {
            this.#pendingRichCallIds.clear();
            throw err;
          }
        }
        this.#recorder?.response(loopCount, response);
        // Response landed after the caller aborted: don't commit or act on it.
        if (signal?.aborted) throw new Error('Agent run aborted');

        const message = response.choices?.[0]?.message;
        if (!message) {
          logger.warn('Agent: LLM returned no message in response. Breaking loop.');
          break;
        }

        let { content, tool_calls } = message;
        let reasoning = message.reasoning || undefined;
        let reasoning_details = message.reasoning_details || undefined;
        let finish_reason = response.choices?.[0]?.finish_reason;

        // Stop hooks / empty-turn recovery run only on a terminal (no-tool_calls)
        // turn, BEFORE the assistant message is committed — so an empty turn never
        // lands in history as a trailing assistant message (keeps the conversation
        // continuation-safe and avoids a 400 on the next run).
        if (!tool_calls || tool_calls.length === 0) {
          const r = await this.#resolveStop({
            payload,
            isStreaming,
            signal,
            turn: loopCount,
            content,
            reasoning,
            reasoning_details,
            finish_reason,
          });
          if (r.continue) {
            await this.#broadcast({ stop_recovery: { turn: loopCount, finish_reason, reasoning } });
            this.#appendUserContent(normalizePrompt(r.prompt));
            continue;
          }
          content = r.content;
          reasoning = r.reasoning;
          reasoning_details = r.reasoning_details;
          tool_calls = r.tool_calls;
          finish_reason = r.finish_reason;
        }

        if (signal?.aborted) throw new Error('Agent run aborted');

        const isEmptyTerminal =
          (!tool_calls || tool_calls.length === 0) && (content == null || String(content).trim() === '');

        if (isEmptyTerminal) {
          // Empty terminal turn (recovery exhausted, or disabled). Do not commit a
          // trailing empty assistant message; terminate and return the content as-is.
          this.#recorder?.snapshot(loopCount, this.messages, this.usage);
          await this.#broadcast({
            turn_end: { turn: loopCount, terminal: true, finish_reason, empty: true, reasoning },
          });
          if (await this.#drainPending()) continue;
          // A late bg exit on this terminal turn: with autoWake, resume so the
          // model acts on it rather than stranding the reminder in history.
          if (this.#drainBgExits() && this.autoWake) continue;
          return content ?? '';
        }

        // Assign ids once so tool results match the assistant message
        if (tool_calls) {
          for (const tc of tool_calls) {
            if (!tc.id) tc.id = `call_${crypto.randomUUID()}`;
          }
        }

        this.messages.push({ role: 'assistant', reasoning, reasoning_details, content, tool_calls });
        this.#recorder?.recordAssistant(loopCount, { content, reasoning, tool_calls });

        if (!tool_calls || tool_calls.length === 0) {
          this.#recorder?.snapshot(loopCount, this.messages, this.usage);
          await this.#broadcast({ turn_end: { turn: loopCount, terminal: true, finish_reason } });
          // A steer delivered during the final turn keeps the loop alive.
          if (await this.#drainPending()) continue;
          // Fold any late bg exits into messages before terminating; with
          // autoWake, resume so the model acts on the exit instead of leaving
          // the reminder stranded in history.
          if (this.#drainBgExits() && this.autoWake) continue;
          break;
        }

        const settled = await Promise.allSettled(tool_calls.map((tc) => this.#executeOneToolCall(tc, signal)));

        const richPartsOrdered = [];
        const richToolIds = [];
        for (let i = 0; i < tool_calls.length; i++) {
          const tc = tool_calls[i];
          const r = settled[i];
          const tool_call_id = tc.id;
          if (r.status === 'fulfilled') {
            const { output, richParts, duration_ms } = r.value;
            this.messages.push({ role: 'tool', content: output, tool_call_id, duration_ms });
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
              duration_ms: r.reason?.duration_ms,
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
        this.#recorder?.snapshot(loopCount, this.messages, this.usage);
        this.#stopAttempts = 0;
        await this.#broadcast({ turn_end: { turn: loopCount, terminal: false, finish_reason } });
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

      // Post-run safety net: if background exits arrived during the window
      // between the last #drainBgExits() in the run loop and this point
      // (#running was still true), re-trigger the autoWake mechanism so
      // they are not stranded (fixes the "window miss" race condition).
      if (this.#pendingBgDrains.length > 0) {
        this.#triggerAutoWake();
      }
    }
  }
}

// Built-in stop hook: recover a terminal turn whose content is empty (only
// reasoning, no tool call). Escalates raw retry x N -> single nudge -> give up.
// A non-retryable error on a retry (e.g. a 400 history-schema error) jumps
// straight to the nudge.
function makeEmptyTurnRecoveryHook({ retries, nudge }) {
  // The configured nudge is just the inner text; wrap it as a system-reminder so
  // the model reads it as framework guidance, not a user turn (consistent with
  // how injectors and background-exit drains surface machine-generated messages).
  const prompt = `<system-reminder>\n${nudge}\n</system-reminder>`;
  return function emptyTurnRecovery({ content, attempt, lastError }) {
    const empty = content == null || String(content).trim() === '';
    if (!empty) return undefined; // non-empty terminal turn — allow normal stop
    if (lastError) {
      return attempt > retries ? { action: 'stop' } : { action: 'continue', prompt };
    }
    if (attempt < retries) return { action: 'retry' };
    if (attempt === retries) return { action: 'continue', prompt };
    return { action: 'stop' };
  };
}

function tailFile(logPath, bytes) {
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (err) {
    return `(unable to tail: ${err.message})`;
  }
}

export function describeJob(agent, id, tailBytes) {
  const job = agent.backgroundJobs?.get(id);
  if (!job) return `- ${id}: not found in agent.backgroundJobs`;
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const head = `- ${id} (${job.kind}): ${job.status}${
    job.exitCode != null ? `, code ${job.exitCode}` : ''
  }, ${elapsed.toFixed(1)}s`;
  let out = head;
  if (job.logPath) {
    const tail = tailFile(job.logPath, tailBytes);
    out += `\n  tail (${tailBytes} bytes):\n${tail
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n')}`;
  }
  if (job.traceLogPath) {
    const traceTail = tailFile(job.traceLogPath, tailBytes);
    out += `\n  trace tail (${tailBytes} bytes):\n${traceTail
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n')}`;
  }
  return out;
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

async function pluginInstructionsInjector() {
  try {
    await skillRegistry._ensureDiscovered();
  } catch (err) {
    logger.warn(`Skill discovery failed: ${err?.message || err}`);
    return '';
  }
  const instructions = skillRegistry.getPluginInstructions();
  if (!instructions || instructions.length === 0) return '';
  const sections = instructions.map(({ plugin, content }) => `### ${plugin}\n${content}`);
  return `## Plugin instructions\n\n${sections.join('\n\n')}`;
}

export default Agent;
