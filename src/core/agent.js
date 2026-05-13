import { withRetry, getDirname, CONSTANTS, groupToolCalls } from './utils.js';
import { ToolRegistry } from '../registry/tool.js';
import { ApiError, ConfigError } from './errors.js';
import logger from './logger.js';
import config from '../config.js';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = getDirname(import.meta);

const REQUEST_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_TURNS = 25;

class Agent {
  #apiKey;
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
    const { apiKey, model, tools, order, only, maxTokens, systemPrompt, maxTurns, effort, maxToolOutputChars } =
      options;

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
    // Max request turns before forcing a break.
    // Set to 0 for unlimited (used by subagents via Delegate).
    this.maxTurns = maxTurns ?? (parseInt(config.MAX_TURNS || 0) || DEFAULT_MAX_TURNS);
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
  }

  // Read-only API key — used by Delegate tool for sub-agents
  get apiKey() {
    return this.#apiKey;
  }

  async #request(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
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
      clearTimeout(timer);
    }
  }

  #buildPayload() {
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

    const payload = {
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: this.systemPrompt + this.#envInfo.join('\n'),
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

    return payload;
  }

  async #send() {
    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this.#request(this.#buildPayload());
    logger.debug(`Received response from LLM.`);

    this.usage.cost += response.usage?.cost || 0;
    this.usage.tokens += response.usage?.total_tokens || 0;

    return response;
  }

  async #sendStream(notify) {
    const payload = this.#buildPayload();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

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
      clearTimeout(timer);
      throw err;
    }

    if (!res.ok) {
      clearTimeout(timer);
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
      clearTimeout(timer);
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
      throw new Error(`invalid JSON arguments — ${parseErr.message}`);
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
  }

  async run(prompt, notify = null, options = {}) {
    const { signal } = options;
    const isStreaming = typeof notify === 'function';

    if (prompt) {
      const contents = Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
      const lastIdx = this.messages.length - 1;

      if (this.messages[lastIdx]?.role === 'user' && Array.isArray(this.messages[lastIdx].content)) {
        this.messages[lastIdx].content.push(...contents);
      } else {
        this.messages.push({ role: 'user', content: contents });
      }
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

      // Soft limit: on the very last allowed turn, if we are coming from a tool execution,
      // inject a warning to encourage a final summary (Subagents only).
      if (this.isSubagent && this.maxTurns > 0 && loopCount === this.maxTurns) {
        const lastMsg = this.messages[this.messages.length - 1];
        if (lastMsg?.role === 'tool') {
          lastMsg.content +=
            '\n\n[SYSTEM] You have reached the maximum allowed request turns. Please provide a final summary of your work now and stop calling tools.';
        }
      }

      const response = await withRetry(() => (isStreaming ? this.#sendStream(notify) : this.#send()), 5);
      const message = response.choices?.[0]?.message;
      if (!message) {
        logger.warn('Agent: LLM returned no message in response. Breaking loop.');
        break;
      }

      const { content, reasoning, tool_calls } = message;

      this.messages.push({ role: 'assistant', reasoning, content, tool_calls });

      if (!tool_calls || tool_calls.length === 0) break;

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
    }

    return this.messages[this.messages.length - 1].content;
  }
}

export default Agent;
