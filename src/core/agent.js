import {
  withRetry,
  getDirname,
  CONSTANTS,
  groupToolCalls,
  ensureSafePath,
  payloadHasMultimodal,
  degradePayload,
} from './utils.js';
import { ToolRegistry } from '../registry/tool.js';
import { ApiError, ConfigError } from './errors.js';
import logger from './logger.js';
import config from '../config.js';
import skillRegistry from '../registry/skill.js';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
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
    } = options;

    if (!apiKey && !config.API_KEY) {
      throw new ConfigError('OPENROUTER_API_KEY is required. Set it in .env or pass it as an option.');
    }
    this.#apiKey = apiKey || config.API_KEY;
    this.model = model;
    this.provider = { order, only };
    this.messages = [];
    this.tools = tools || new ToolRegistry();
    this.effort = effort || 'high';
    this.maxTokens = parseInt(maxTokens || config.MAX_TOKENS || 0) || undefined;
    this.usage = { cost: 0, tokens: 0 };
    this.subagents = new Map();
    this.fileState = new Map();
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

  async #request(payload) {
    const controller = new AbortController();
    const idle = makeIdleTimer(REQUEST_TIMEOUT, controller);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
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
    const messagesForPayload = this.messages.map((msg, idx) => {
      if (
        idx === this.messages.length - 1 &&
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
      provider: this.provider,
      max_tokens: this.maxTokens,
      reasoning: { effort: this.effort },
    };

    if (payload.tools.length === 0) delete payload.tools;
    if (!payload.max_tokens) delete payload.max_tokens;

    for (const hook of this.#beforeRequestHooks) {
      await hook(payload);
    }

    return payload;
  }

  async #send(payload) {
    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this.#request(payload);
    logger.debug(`Received response from LLM.`);

    this.usage.cost += response.usage?.cost || 0;
    this.usage.tokens += response.usage?.total_tokens || 0;

    return response;
  }

  async #sendStream(notify, payload) {
    const controller = new AbortController();
    const idle = makeIdleTimer(REQUEST_TIMEOUT, controller);

    let res;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
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

    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        idle.reset(); // data arrived — reset idle clock
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') break outer;

          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          this.usage.cost += chunk.usage?.cost || 0;
          this.usage.tokens += chunk.usage?.total_tokens || 0;

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          const cd = delta.content || '';
          const rd = delta.reasoning || '';
          if (cd) content += cd;
          if (rd) reasoning += rd;

          for (const tc of delta.tool_calls || []) {
            if (!tcMap[tc.index]) {
              tcMap[tc.index] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.function?.name) tcMap[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) tcMap[tc.index].function.arguments += tc.function.arguments;
          }

          if (cd || rd) {
            try {
              await notify({
                content_delta: cd || null,
                content: content || null,
                reasoning_delta: rd || null,
                reasoning: reasoning || null,
              });
            } catch (err) {
              logger.debug('Notify callback error:', err.message);
            }
          }
        }
      }
    } finally {
      idle.clear();
      reader.releaseLock();
    }

    const tool_calls = Object.keys(tcMap).length ? Object.values(tcMap) : undefined;
    if (tool_calls) {
      try {
        await notify({ tool_calls });
      } catch (err) {
        logger.debug('Notify callback error:', err.message);
      }
    }

    return {
      choices: [{ message: { content: content || null, reasoning: reasoning || null, tool_calls } }],
    };
  }

  async #executeOneToolCall(tc, signal, notify) {
    const name = tc.function.name;
    const tool_call_id = tc.id || `call_${crypto.randomUUID()}`;
    let input;
    try {
      input = JSON.parse(tc.function.arguments);
    } catch (parseErr) {
      logger.warn(`Agent: failed to parse tool arguments for "${name}": ${parseErr.message}`);
      throw new Error(`invalid JSON arguments — ${parseErr.message}`, { cause: parseErr });
    }

    if (typeof notify === 'function') {
      try {
        await notify({ tool_start: { tool_call_id, name, input } });
      } catch (err) {
        logger.debug('Notify callback error:', err.message);
      }
    }

    logger.debug('Agent: Executing tool:', name);
    const started = Date.now();
    let output;
    let toolError;
    try {
      const result = await this.tools.execute(name, input, { agent: this, signal });
      output = typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      toolError = err;
    }
    const duration_ms = Date.now() - started;

    if (typeof notify === 'function') {
      const payload = { tool_call_id, name, duration_ms };
      if (toolError) payload.error = toolError.message;
      else payload.output = output;
      try {
        await notify({ tool_end: payload });
      } catch (err) {
        logger.debug('Notify callback error:', err.message);
      }
    }

    if (toolError) throw toolError;
    return output;
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

  // Flush queued steer prompts into messages as a trailing user message.
  async #drainPending(notify) {
    if (this.#pending.length === 0) return false;
    const items = this.#pending.splice(0, this.#pending.length);
    for (const parts of items) this.#appendUserContent(parts);
    if (typeof notify === 'function') {
      try {
        await notify({ steer_applied: { count: items.length } });
      } catch (err) {
        logger.debug('Notify callback error:', err.message);
      }
    }
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
  }

  async cleanup() {
    if (!this._storageTmpDir) return;
    let entries;
    try {
      entries = await readdir(this._storageTmpDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        await unlink(path.join(this._storageTmpDir, entry.name));
      } catch (err) {
        logger.debug(`cleanup: failed to delete ${entry.name}: ${err.message}`);
      }
    }
  }

  async #runLoop(prompt, notify = null, options = {}) {
    const { signal } = options;
    const isStreaming = typeof notify === 'function';

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
        response = await withRetry(() => (isStreaming ? this.#sendStream(notify, payload) : this.#send(payload)), 5);
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status === 400 &&
          !this.#multimodalUnsupported &&
          payloadHasMultimodal(payload)
        ) {
          logger.warn('Request rejected (400) with multimodal tool content; degrading and retrying.');
          this.#multimodalUnsupported = true;
          degradePayload(payload);
          response = await withRetry(() => (isStreaming ? this.#sendStream(notify, payload) : this.#send(payload)), 5);
        } else {
          throw err;
        }
      }
      const message = response.choices?.[0]?.message;
      if (!message) {
        logger.warn('Agent: LLM returned no message in response. Breaking loop.');
        break;
      }

      const { content, reasoning, tool_calls } = message;

      this.messages.push({ role: 'assistant', reasoning, content, tool_calls });

      if (!tool_calls || tool_calls.length === 0) {
        // A steer delivered during the final turn keeps the loop alive.
        if (await this.#drainPending(notify)) continue;
        break;
      }

      const groups = groupToolCalls(tool_calls, this.tools);

      for (const group of groups) {
        const settled = await Promise.allSettled(group.map((tc) => this.#executeOneToolCall(tc, signal, notify)));

        for (let i = 0; i < group.length; i++) {
          const tc = group[i];
          const r = settled[i];
          const tool_call_id = tc.id || `call_${crypto.randomUUID()}`;
          if (r.status === 'fulfilled') {
            this.messages.push({ role: 'tool', content: r.value, tool_call_id });
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

        if (signal?.aborted) {
          throw new Error('Agent run aborted');
        }
      }

      // Flush any steer queued during this turn's tool execution.
      await this.#drainPending(notify);
    }

    return this.messages[this.messages.length - 1].content;
  }

  async run(prompt, notify = null, options = {}) {
    // Re-entrancy guard: a run() call made while a loop is active enqueues its
    // prompt for the active loop instead of starting a second one.
    if (this.#running) {
      if (prompt != null && prompt !== '') {
        this.#pending.push(normalizePrompt(prompt));
      }
      return this.#activeRunPromise;
    }
    this.#running = true;
    this.#activeRunPromise = this.#runLoop(prompt, notify, options);
    try {
      return await this.#activeRunPromise;
    } finally {
      this.#running = false;
      this.#activeRunPromise = null;
      // Safety net: preserve any prompt queued during an abnormal loop exit.
      await this.#drainPending(null);
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
