import { fileURLToPath } from 'node:url';
import { resolveApiDialect } from '../support/http.js';
import { degradePayload, LIMITS, sanitizeAppName } from '../support/payload.js';
import { RequestClient } from './request-client.js';
import { createEmptyTurnRecoveryHook, Lifecycle } from './lifecycle.js';
import { ToolExecutor } from './tool-executor.js';
import { BackgroundJobs } from './background-jobs.js';
import { drainBackgroundExits, RunLoop } from './run-loop.js';
import { FileState } from './file-state.js';
import { resolveModelSettings, resolveProviderRouting } from './settings.js';
import {
  contextFilesInjector,
  defaultDateInjector,
  memoryHintInjector,
  memoryIndexInjector,
  pluginInstructionsInjector,
  skillListInjector,
} from './injectors.js';
import { sanitizeAssistantReasoning } from '../core/reasoning.js';
import { ToolRegistry } from '../registries/tool-registry.js';
import { ConfigError } from '../support/errors.js';
import { createSessionRecorder } from '../recording/session-recorder.js';
import { loadEnvironmentConfig } from '../config/environment.js';
import { SkillRegistry } from '../registries/skill-registry.js';
import { resolveLogger } from '../support/logger.js';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

const __dirname = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));

function resolveStoragePath(p) {
  if (!p || typeof p !== 'string') return null;
  const expanded = p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(expanded);
}

// The rich-output user message keeps this marker after its attachments are
// removed, which lets degradation replace the incomplete message.
const RICH_CONTENT_INTRO = 'Multimodal content from the previous tool results:';
const RICH_CONTENT_DROPPED =
  '[Multimodal content could not be displayed. This model does not support it. Do not describe or guess the content.]';

const DEFAULT_MAX_TURNS = 25;

// The agent a caller holds. It owns the conversation, the settings each request
// is built from, and the file and subagent state that built-in tools reach
// through `ctx.agent`. Everything else is delegated to a collaborator built in
// the constructor. The run loop drives a run and calls back here for the payload
// and the rich-content bookkeeping, both of which need the whole conversation.
class Agent {
  #apiKey;
  #baseUrl;
  #instructionCache;
  #multimodalUnsupported = false;
  #notifyCallbacks = new Set();
  #subscribedCallbacks = new Set();
  #pendingRichCallIds = new Set();
  #richUserMsgIdx = -1;
  #wakeScheduled = false;
  #recorder = null;
  #recoveryHook = null;
  #recordConfig = null;
  #sessionId;
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
    const config = loadEnvironmentConfig();
    const {
      apiKey,
      baseUrl,
      model,
      embeddingModel,
      tools,
      systemPrompt,
      maxTurns,
      maxToolOutputChars,
      injectors,
      contextFiles,
      storagePaths,
      appName,
      memoryTypes,
      isSubagent,
      restricted,
      autoWake,
      autoWakeNotify,
      autoWakeOptions,
      record,
      emptyTurnRecovery,
      sessionId,
      logger,
      skillRegistry: suppliedSkillRegistry,
    } = options;

    this.logger = logger ?? resolveLogger(undefined, { debug: config.debug });
    this.config = { ...config, environment: { ...process.env } };
    this.skillRegistry = suppliedSkillRegistry ?? new SkillRegistry({ logger: this.logger });
    this.restricted = restricted !== false;
    if (this.restricted === false) {
      this.logger.warn({ component: 'agent', restricted: false }, 'Agent constructed with security checks disabled');
    }

    if (!apiKey && !config.apiKey) {
      throw new ConfigError('OPENROUTER_API_KEY is required. Set it in .env or pass it as an option.');
    }
    this.#apiKey = apiKey || config.apiKey;
    this.#baseUrl = baseUrl || config.baseUrl || 'https://openrouter.ai/api/v1';
    this.dialect = resolveApiDialect(this.#baseUrl);
    this.#sessionId = sessionId ?? crypto.randomUUID();
    this.requestClient = new RequestClient({
      apiKey: this.#apiKey,
      baseUrl: this.#baseUrl,
      model,
      logger: this.logger,
      retryOptions: { attempts: config.maxRetries },
    });
    this.lifecycle = new Lifecycle({ logger: this.logger });
    this.#recoveryHook = createEmptyTurnRecoveryHook(emptyTurnRecovery, config);

    this.model = model;
    this.embeddingModel = embeddingModel ?? config.embeddingModel ?? 'openai/text-embedding-3-small';
    this.isSubagent = !!isSubagent;
    this.provider = resolveProviderRouting(options, config);

    this.messages = [];
    this.tools = tools || new ToolRegistry({ restricted: this.restricted, logger: this.logger });
    this.toolExecutor = new ToolExecutor({ registry: this.tools, logger: this.logger });

    // Sampling, reasoning and completion limits land as public fields, so a
    // caller can change any of them between runs.
    Object.assign(this, resolveModelSettings(options, config));

    this.usage = { cost: 0, tokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    this.subagents = new Map();
    this.fileState = new FileState();
    this.currentTurn = 0;
    // Zero allows unlimited request turns, which delegated subagents use.
    if (maxTurns !== undefined) {
      this.maxTurns = maxTurns;
    } else if (config.maxTurns !== undefined) {
      this.maxTurns = config.maxTurns;
    } else {
      this.maxTurns = DEFAULT_MAX_TURNS;
    }
    this.maxToolOutputChars = maxToolOutputChars ?? LIMITS.maxToolOutput;
    this.autoWake = autoWake !== undefined ? !!autoWake : (config.autoWake ?? false);
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
          this.logger.debug(
            { component: 'agent' },
            'No RULE.md was found, so the agent is using its default instruction',
          );
        }

        return base;
      })();

    if (injectors?.date !== false) {
      this.registerInjector({ name: 'date', scope: 'per-turn', run: defaultDateInjector });
    }

    if (injectors?.contextFiles !== false) {
      const files = Array.isArray(contextFiles) && contextFiles.length > 0 ? contextFiles : ['AGENTS.md'];
      this.registerInjector({
        name: 'contextFiles',
        scope: 'first-turn',
        run: contextFilesInjector(files, () => this.trustedPaths),
      });
    }

    this.appName = sanitizeAppName(appName ?? config.appName ?? LIMITS.defaultAppName);
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

    this.skillRegistry.configure({ pluginsDir: this._pluginsDir });

    const _projectRoot = path.resolve(process.cwd());
    this.trustedPaths = new Set();
    for (const dir of [resolvedMemoryDir, resolvedTmpDir, resolvedPluginsDir].filter(Boolean)) {
      const rel = path.relative(_projectRoot, dir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) this.trustedPaths.add(dir);
    }

    this.backgroundJobs = new BackgroundJobs({
      logger: this.logger,
      // The fallback log directory is process-scoped and created on first use.
      logDirectory: resolvedTmpDir || path.join(os.tmpdir(), `${this.appName}-${process.pid}`),
      isBusy: () => this.isRunning,
    });
    this.backgroundJobs.onExit(() => this.#triggerAutoWake());
    this.runLoop = new RunLoop({
      requestClient: this.requestClient,
      toolExecutor: this.toolExecutor,
      lifecycle: this.lifecycle,
      backgroundJobs: this.backgroundJobs,
      logger: this.logger,
    });

    this._memoryTypes = {
      user: 'Information about the user: role, goals, knowledge, preferences.',
      feedback: 'Guidance the user gave about how to approach work. Lead with the rule, include why and how to apply.',
      project: "Ongoing work context, decisions, deadlines that aren't derivable from code/git.",
      reference: 'Pointers to external systems: dashboards, tracker projects, channels.',
      ...(memoryTypes || {}),
    };

    if (injectors?.memoryIndex !== false) {
      this.registerInjector({
        name: 'memoryIndex',
        scope: 'first-turn',
        run: memoryIndexInjector(
          () => this._memoryDir,
          () => this.trustedPaths,
        ),
      });
    }

    if (injectors?.memoryHint !== false) {
      this.registerInjector({
        name: 'memoryHint',
        scope: 'first-turn',
        run: memoryHintInjector(
          () => this._memoryDir,
          () => this._memoryTypes,
        ),
      });
    }

    if (injectors?.skillList !== false) {
      this.registerInjector({ name: 'skillList', scope: 'first-turn', run: skillListInjector(this.skillRegistry) });
    }
    if (injectors?.pluginInstructions !== false) {
      this.registerInjector({
        name: 'pluginInstructions',
        scope: 'first-turn',
        run: pluginInstructionsInjector(this.skillRegistry),
      });
    }
  }

  // effort is the shorthand for reasoning.effort.
  get effort() {
    return this.reasoning?.effort ?? loadEnvironmentConfig().reasoning.effort ?? 'high';
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

  // delegateTask reads the API key through this getter when it creates a child.
  get apiKey() {
    return this.#apiKey;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  get isRunning() {
    return this.runLoop.isRunning;
  }

  registerTools(tools) {
    this.tools.registerMany(Array.isArray(tools) ? tools : [tools]);
    return this;
  }

  // Queue a prompt for the active run loop. The call is nonblocking and returns false when
  // idle (no loop to steer) or when the prompt is empty.
  steer(prompt) {
    return this.runLoop.steer(prompt);
  }

  // Rebuild an Agent that drives a recorded run without network calls.
  // Each turn's transport yields the recorded response via the _sendForTest
  // seam. toolMode 'replay' (default) returns recorded tool outputs (no side
  // effects re-run); 'live' re-executes the provided tools for real.
  static replay(recording, { tools, skillRegistry, toolMode = 'replay' } = {}) {
    if (!recording || recording.level !== 'full') {
      throw new Error("Agent.replay requires a 'full'-level recording (record at level 'full' to capture responses)");
    }
    if (toolMode !== 'replay' && toolMode !== 'live') {
      throw new Error(`Agent.replay received unknown toolMode '${toolMode}'. Use 'replay' or 'live'.`);
    }
    const hasTools = tools !== undefined;
    const hasSkillRegistry = skillRegistry !== undefined;
    if (hasTools !== hasSkillRegistry || (hasTools && (!tools || !skillRegistry))) {
      throw new ConfigError('Agent.replay requires tools and skillRegistry to be provided together');
    }
    const agent = new Agent({
      apiKey: 'replay',
      model: recording.model,
      tools,
      skillRegistry,
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

    agent._sendForTest = async () => {
      const raw = recording.responseAt(agent.currentTurn);
      if (!raw) {
        // A missing recorded turn cannot succeed on retry.
        const err = new Error(`replay: no recorded response for turn ${agent.currentTurn}`);
        err.status = 400;
        throw err;
      }
      return raw;
    };

    if (toolMode === 'replay') {
      // The registry needs a definition before the override hook can return a
      // recorded result for a tool that is not installed.
      const known = new Set(agent.tools.listTools().map((t) => t.name));
      for (const ev of recording.events) {
        if (ev.type !== 'toolCalls') continue;
        for (const c of ev.calls) {
          if (known.has(c.name)) continue;
          agent.tools.register({
            name: c.name,
            description: 'replay stub',
            inputSchema: { type: 'object', properties: {} },
            execute: async () => '',
          });
          known.add(c.name);
        }
      }
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
      throw new Error(
        `The recording has no snapshot at turn ${turn}. Use recording level 'snapshots' or 'full' to fork.`,
      );
    }
    // Forks share read-only plugins but do not inherit recording.
    const childLogger = this.logger.child({ component: 'agent', agent: 'fork' });
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
      logger: childLogger,
      skillRegistry: this.skillRegistry,
    });
    // This list mirrors the public settings returned by resolveModelSettings.
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
    this.#recorder = createSessionRecorder({ ...this.#recordConfig, model: this.model, logger: this.logger });
    return this.#recorder.path;
  }

  async stopRecording() {
    if (!this.#recorder) return null;
    const p = this.#recorder.path;
    try {
      await this.#recorder.close();
    } catch (err) {
      this.logger.warn({ component: 'agent', error: err }, 'Failed to close session recorder');
    }
    this.#recorder = null;
    this.#recordConfig = null;
    return p;
  }

  onBackgroundExit(fn) {
    return this.backgroundJobs.onExit(fn);
  }

  // A persistent event listener is independent of run() and returns a disposer.
  // An active subscription selects the SSE streaming transport for that run.
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
    this.#subscribedCallbacks.add(fn);
    return () => this.#subscribedCallbacks.delete(fn);
  }

  // Report a finished background job. Tools that start their own processes call
  // this when the process ends; auto-wake is wired to it through a listener
  // registered in the constructor.
  _fireBackgroundExit(event) {
    this.backgroundJobs.reportExit(event);
  }

  _onBackgroundExitRaw(fn) {
    return this.backgroundJobs.onRawExit(fn);
  }

  registerInjector({ name, scope, run } = {}) {
    return this.lifecycle.registerInjector({ name, scope, run });
  }

  unregisterInjector(name) {
    this.lifecycle.unregisterInjector(name);
  }

  onBeforeRequest(fn) {
    return this.lifecycle.onBeforeRequest(fn);
  }

  // Stop hooks fire on a terminal turn with no tool calls. A hook can allow the
  // stop, retry the same payload, or continue with a user nudge. User hooks run
  // before built-in recovery, and the first non-stop decision wins. Registration
  // returns a disposer.
  onStop(fn) {
    return this.lifecycle.onStop(fn);
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
      this.#recorder = createSessionRecorder({ ...this.#recordConfig, model: this.model, logger: this.logger });
    } catch (err) {
      this.logger.warn({ component: 'agent', error: err }, 'Failed to start session recorder');
      this.#recordConfig = null;
    }
  }

  async #broadcast(event) {
    this.#recorder?.record(event, this.currentTurn);
    const promises = [];
    const targets =
      event && event.turnEnd
        ? this.#subscribedCallbacks
        : new Set([...this.#notifyCallbacks, ...this.#subscribedCallbacks]);
    for (const notify of targets) {
      if (typeof notify === 'function') {
        promises.push(
          (async () => {
            try {
              await notify(event);
            } catch (err) {
              this.logger.debug({ component: 'agent', error: err }, 'Notify callback failed');
            }
          })(),
        );
      }
    }
    await Promise.all(promises);
  }

  // Build one turn's request from the current conversation, tools and settings.
  // The run loop calls this once per turn, before any retry.
  async _buildPayload() {
    const isOpenAI = this.dialect === 'openai';
    const messagesCopy = [...this.messages];
    const messagesForPayload = messagesCopy.map((msg, idx) => {
      // User content is already structured, so put the cache breakpoint on its
      // final part without changing the stored conversation history.
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
      // Tool messages carry internal history and UI metadata that cannot reach
      // the provider. Rebuilding the wire shape prevents leaks and avoids
      // deoptimizing cloned objects through property deletion.
      if (msg.role === 'tool') {
        const content =
          !isOpenAI && idx === messagesCopy.length - 1 && typeof msg.content === 'string'
            ? [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }]
            : msg.content;
        return { role: 'tool', content, tool_call_id: msg.tool_call_id };
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

    if (!isOpenAI) payload.session_id = this.#sessionId;

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
        // OpenRouter names this wire field `ignore`.
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

    await this.lifecycle.runBeforeRequest(payload);

    // A provider that refused rich parts receives text-only retries for this run.
    if (this.#multimodalUnsupported) degradePayload(payload);

    return payload;
  }

  #triggerAutoWake() {
    if (this.autoWake && !this.#wakeScheduled) {
      this.#wakeScheduled = true;
      // A microtask coalesces rapid exits into one wake-up and one drain.
      queueMicrotask(() => {
        this.#wakeScheduled = false;
        if (this.isRunning) return;
        if (!this.backgroundJobs.hasPendingExits()) return;

        // The resumed run must see queued exits in its first request.
        drainBackgroundExits(this.backgroundJobs, this.messages);

        const notify = typeof this.autoWakeNotify === 'function' ? this.autoWakeNotify : null;
        this.run(null, notify, this.autoWakeOptions ?? {}).catch((err) =>
          this.logger.warn({ component: 'agent', error: err }, 'Auto-wake run failed'),
        );
      });
    }
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

  _scheduleTimer({ durationMs, watch = [], tailBytes = 4096, reason, prompt }) {
    return this.backgroundJobs.scheduleTimer({ durationMs, watch, tailBytes, reason, prompt });
  }

  // Background logs live outside the project root, so the directory has to be
  // trusted before file tools can read a job's log.
  _resolveBackgroundLogDir() {
    const dir = this.backgroundJobs.resolveLogDir();
    if (!this.trustedPaths.has(dir)) this.trustedPaths.add(dir);
    return dir;
  }

  async cleanup() {
    if (this.#recorder) {
      try {
        await this.#recorder.close();
      } catch (err) {
        this.logger.warn({ component: 'agent', error: err }, 'Failed to close session recorder');
      }
      this.#recorder = null;
      this.#recordConfig = null;
    }
    await this.backgroundJobs.cleanup();

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
          this.logger.debug({ component: 'agent', path: entry.name, error: err }, 'Cleanup failed to delete file');
        }
      }
    } else if (this.backgroundJobs.logDirectory) {
      // The fallback directory belongs to this agent process.
      try {
        await rm(this.backgroundJobs.logDirectory, { recursive: true, force: true });
      } catch (err) {
        this.logger.debug(
          { component: 'agent', path: this.backgroundJobs.logDirectory, error: err },
          'Cleanup failed to remove log directory',
        );
      }
    }

    if (this.tools && typeof this.tools.cleanup === 'function') {
      try {
        await this.tools.cleanup();
      } catch (err) {
        this.logger.warn({ component: 'agent', error: err }, 'Failed to clean up tools registry');
      }
    }

    if (this.subagents) {
      for (const [id, subagent] of this.subagents) {
        try {
          await subagent.cleanup();
        } catch (err) {
          this.logger.warn({ component: 'agent', subagentId: id, error: err }, 'Failed to clean up subagent');
        }
      }
      this.subagents.clear();
    }
  }

  // The provider refused the rich parts of a payload and the request client has
  // stripped them. Mirror that loss in the conversation so later turns stay
  // text-only and the model is told what it can no longer see.
  _dropRichContent(payload) {
    this.#multimodalUnsupported = true;
    for (const msg of this.messages) {
      if (msg.role === 'tool' && this.#pendingRichCallIds.has(msg.tool_call_id)) {
        msg.content = (msg.content ? msg.content + '\n' : '') + RICH_CONTENT_DROPPED;
      }
    }
    this.#pendingRichCallIds.clear();
    if (this.#richUserMsgIdx >= 0) {
      this.messages[this.#richUserMsgIdx] = { role: 'user', content: RICH_CONTENT_DROPPED };
      this.#richUserMsgIdx = -1;
    }
    // A bare rich-content intro becomes an explicit notice that its attachments
    // are no longer available.
    for (const msg of payload.messages) {
      if (msg.role === 'user' && msg.content === RICH_CONTENT_INTRO) {
        msg.content = RICH_CONTENT_DROPPED;
        break;
      }
    }
  }

  // Queue the multimodal parts a tool group produced as a follow-up user
  // message, and remember which tool results they came from so a later
  // degradation can rewrite both.
  _appendRichContent(parts, toolCallIds) {
    this.#richUserMsgIdx = this.messages.length;
    this.messages.push({
      role: 'user',
      content: [{ type: 'text', text: RICH_CONTENT_INTRO }, ...parts],
    });
    for (const id of toolCallIds) this.#pendingRichCallIds.add(id);
  }

  // The request carrying this turn's rich content has settled, so stop tracking
  // the parts it carried. After a failed send the rich user message keeps its
  // index, so a later degradation can still rewrite it.
  _closeRichContentWindow({ sent }) {
    this.#pendingRichCallIds.clear();
    if (sent) this.#richUserMsgIdx = -1;
  }

  // Tools stop attaching rich parts once the provider has refused them for this run.
  get _multimodalUnsupported() {
    return this.#multimodalUnsupported;
  }

  // Built-in empty-turn recovery, or null when it is switched off. It always
  // runs after user stop hooks, which a shared hook list cannot express, so it
  // stays here and is handed to the lifecycle per terminal turn.
  get _recoveryHook() {
    return this.#recoveryHook;
  }

  // This context gives the run loop live access to values that can change mid-run.
  #runContext({ signal } = {}) {
    const agent = this;
    return {
      messages: this.messages,
      usage: this.usage,
      get currentTurn() {
        return agent.currentTurn;
      },
      set currentTurn(turn) {
        agent.currentTurn = turn;
      },
      get maxTurns() {
        return agent.maxTurns;
      },
      get recorder() {
        return agent.#recorder;
      },
      isStreaming: this.#notifyCallbacks.size > 0 || this.#subscribedCallbacks.size > 0,
      broadcast: (event) => this.#broadcast(event),
      signal,
      agent,
    };
  }

  async run(prompt, notify = null, options = {}) {
    if (notify) {
      this.#notifyCallbacks.add(notify);
    }
    // A concurrent run() call queues its prompt on the active loop.
    if (this.runLoop.isRunning) {
      // The active loop keeps the context it started with, so there is none to pass.
      return this.runLoop.run(prompt, null);
    }
    this.#maybeStartRecorder();
    try {
      return await this.runLoop.run(prompt, this.#runContext(options));
    } finally {
      this.#notifyCallbacks.clear();

      // Exits can arrive after the run loop's last drain but before it becomes
      // idle. Rechecking here prevents those events from remaining queued.
      if (this.backgroundJobs.hasPendingExits()) {
        this.#triggerAutoWake();
      }
    }
  }
}

export default Agent;
