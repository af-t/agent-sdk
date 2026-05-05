import { withRetry, ToolRegistry } from './utils.js';
import { fileURLToPath } from 'node:url';
import { ApiError, ConfigError } from './errors.js';
import logger from './logger.js';
import config from '../config.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// import.meta.dirname is experimental; provide fallback
const __dirname = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));

class Agent {
  constructor (options = {}) {
    const {
      apiKey,
      model,
      tools,
      order,
      only,
      maxTokens,
      systemPrompt
    } = options;

    if (!apiKey && !config.API_KEY) {
      throw new ConfigError('OPENROUTER_API_KEY is required. Set it in .env or pass it as an option.');
    }
    this.apiKey = apiKey;
    this.model = model;
    this.provider = { order, only };
    this.messages = [];
    this.tools = tools || new ToolRegistry();
    this.effort = 'high';
    this.max_tokens = parseInt(maxTokens || config.MAX_TOKENS || 0) || undefined;
    this.usage = { cost: 0, tokens: 0 };
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

  async _request(payload) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...payload, stream: false })
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
  }

  async _send() {
    const lastMsg = this.messages[this.messages.length - 1];

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
      max_tokens: this.max_tokens,
      reasoning_effort: this.effort
    };

    if (payload.tools.length === 0) delete payload.tools;
    if (!payload.max_tokens) delete payload.max_tokens;

    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this._request(payload);
    logger.debug(`Received response from LLM.`);

    this.usage.cost += (response.usage?.cost || 0);
    this.usage.tokens = (response.usage?.total_tokens || 0);

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

    while (true) {
      // Check abort signal
      if (signal?.aborted) {
        throw new Error('Agent run aborted');
      }

      const response = await withRetry(() => this._send(), 5);
      const message = response.choices?.[0]?.message;
      if (!message) break;

      const { content, reasoning, tool_calls } = message;
      notify({ content, reasoning, tool_calls });

      this.messages.push({ role: 'assistant', reasoning, content, tool_calls });

      if (!tool_calls || tool_calls.length === 0) break;
      for (const tc of tool_calls) {
        // Check abort signal before each tool execution
        if (signal?.aborted) {
          throw new Error('Agent run aborted');
        }

        const name = tc.function.name;
        const input = JSON.parse(tc.function.arguments);

        logger.debug('Agent: Executing tool:', name);
        const result = await this.tools.execute(name, input, { agent: this });

        this.messages.push({
          role: 'tool',
          content: (typeof result === 'string') ? result : JSON.stringify(result),
          tool_call_id: tc.id
        });
      }
    }

    return this.messages[this.messages.length - 1].content;
  }
}

export default Agent;
