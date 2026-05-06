import { withRetry, ToolRegistry } from './utils.js';
import { getDirname } from './dirname.js';
import { ApiError, ConfigError } from './errors.js';
import logger from './logger.js';
import config from '../config.js';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const __dirname = getDirname(import.meta);

const REQUEST_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_TOOL_LOOPS = 25;

class Agent {
  #apiKey;

  constructor (options = {}) {
    const {
      apiKey,
      model,
      tools,
      order,
      only,
      maxTokens,
      systemPrompt,
      maxToolLoops,
      reasoningEffort
    } = options;

    if (!apiKey && !config.API_KEY) {
      throw new ConfigError('OPENROUTER_API_KEY is required. Set it in .env or pass it as an option.');
    }
    this.#apiKey = apiKey || config.API_KEY;
    this.model = model;
    this.provider = { order, only };
    this.messages = [];
    this.tools = tools || new ToolRegistry();
    this.reasoningEffort = reasoningEffort || 'high';
    this.maxTokens = parseInt(maxTokens || config.MAX_TOKENS || 0) || undefined;
    this.usage = { cost: 0, tokens: 0 };
    // Max tool loop iterations before forcing a break.
    // Set to 0 for unlimited (used by subagents via Delegate).
    this.maxToolLoops = maxToolLoops ?? DEFAULT_MAX_TOOL_LOOPS;
    this.systemPrompt = systemPrompt || (() => {
      let base = 'You are an interactive agent that helps users with software engineering tasks.';
      try {
        base = fs.readFileSync(path.join(__dirname, '..', '..', 'RULE.md'), 'utf8');
      } catch {
        logger.debug('No RULE.md found, using default instruction.');
      }

      const envInfo = [
        '', '',
        '# Environment',
        'You have been invoked in the following environment:',
        ` - Primary working directory: ${process.cwd()}`,
        ` - Is a git repository: ${!!fs.existsSync('.git')}`,
        ` - Platform: ${os.platform()}`,
        ` - Shell: ${process.env.SHELL || 'unknown'}`,
        ` - OS version: ${os.release()}`
      ];

      return base + envInfo.join('\n');
    })();
  }

  /** Get API key (read-only) — used by Delegate tool to create sub-agents */
  get apiKey() {
    return this.#apiKey;
  }

  async _request(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...payload, stream: false }),
        signal: controller.signal
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
          responseBody
        );
      }

      return responseBody;
    } finally {
      clearTimeout(timer);
    }
  }

  async _send() {
    // Build messages for payload with cache_control on a defensive copy
    const messagesForPayload = this.messages.map((msg, idx) => {
      // Only add cache_control to the last user message's last content part (on a copy)
      if (idx === this.messages.length - 1 && msg.role === 'user' && Array.isArray(msg.content) && msg.content.length > 0) {
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
          content: [{
            type: 'text',
            text: this.systemPrompt,
            cache_control: { type: 'ephemeral' }
          }]
        },
        ...messagesForPayload
      ],
      tools: this.tools.getDefinitions(),
      provider: this.provider,
      max_tokens: this.maxTokens,
      reasoning_effort: this.reasoningEffort
    };

    if (payload.tools.length === 0) delete payload.tools;
    if (!payload.max_tokens) delete payload.max_tokens;

    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this._request(payload);
    logger.debug(`Received response from LLM.`);

    this.usage.cost += (response.usage?.cost || 0);
    this.usage.tokens += (response.usage?.total_tokens || 0);

    return response;
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

  async run(prompt, notify = () => null, options = {}) {
    const { signal } = options;

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

      if (this.maxToolLoops > 0 && ++loopCount > this.maxToolLoops) {
        logger.warn(`Agent: max tool loop iterations reached (${this.maxToolLoops}), forcing break.`);
        break;
      }

      const response = await withRetry(() => this._send(), 5);
      const message = response.choices?.[0]?.message;
      if (!message) {
        logger.warn('Agent: LLM returned no message in response. Breaking loop.');
        break;
      }

      const { content, reasoning, tool_calls } = message;
      try {
        await notify({ content, reasoning, tool_calls });
      } catch (err) {
        logger.debug('Notify callback error:', err.message);
      }

      this.messages.push({ role: 'assistant', reasoning, content, tool_calls });

      if (!tool_calls || tool_calls.length === 0) break;
      for (const tc of tool_calls) {
        // Check abort signal before each tool execution
        if (signal?.aborted) {
          throw new Error('Agent run aborted');
        }

        const name = tc.function.name;
        let input;
        try {
          input = JSON.parse(tc.function.arguments);
        } catch (parseErr) {
          logger.warn(`Agent: failed to parse tool arguments for "${name}": ${parseErr.message}`);
          this.messages.push({
            role: 'tool',
            content: `Error: invalid JSON arguments — ${parseErr.message}`,
            tool_call_id: tc.id || `call_${crypto.randomUUID()}`
          });
          continue;
        }

        logger.debug('Agent: Executing tool:', name);
        let result;
        try {
          result = await this.tools.execute(name, input, { agent: this });
        } catch (toolErr) {
          logger.warn(`Tool ${name} failed: ${toolErr.message}`);
          this.messages.push({
            role: 'tool',
            content: `Error: ${toolErr.message}`,
            tool_call_id: tc.id || `call_${crypto.randomUUID()}`
          });
          continue;
        }

        this.messages.push({
          role: 'tool',
          content: (typeof result === 'string') ? result : JSON.stringify(result),
          tool_call_id: tc.id || `call_${crypto.randomUUID()}`
        });
      }
    }

    return this.messages[this.messages.length - 1].content;
  }
}

export default Agent;
