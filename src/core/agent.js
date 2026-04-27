import { withRetry } from './utils.js';
import terminalManager from './terminal.js';
import logger from './logger.js';
import config from '../config.js';

class Agent {
  constructor (options = {}) {
    const {
      apiKey,
      model,
      tools,
      order,
      only,
      systemPrompt = "You are a helpful AI assistant.",
      isSubagent = false,
      maxTokens,
      // Inject managers if provided (for subagents)
      tManager = terminalManager
    } = options;

    this.apiKey = apiKey;
    this.model = model;
    this.provider = {
      order: order,
      only: only
    };
    this.messages = [];
    this.system = [{ type: 'text', text: systemPrompt }];
    this.tools = tools;
    this.terminalManager = tManager;
    this.isSubagent = isSubagent;
    this.thinking = { type: 'enabled', budget_tokens: 32000 };
    this.max_tokens = parseInt(maxTokens || config.MAX_TOKENS) || undefined;
    this.usage = { cost: 0, tokens: 0 };
    this.finalReport = null; // Store subagent result
    this.context = new Map();

    // register builtin tools
    this.use([
      {
        name: 'Report',
        description: 'Signal the completion of an assigned task. Call this tool to return a final summary and a list of artifacts (files created or modified) to the requester.',
        input_schema: {
          type: 'object',
          properties: {
            data: { type: 'string', description: 'The final JSON data to return' },
            summary: { type: 'string', description: 'Executive summary of work performed' }
          },
          required: ['data']
        },
        execute: async() => null
      },
      {
        name: 'StoreSet',
        description: 'Store a value in the short-term context.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to store' },
            value: { type: 'string', description: 'The value to store' }
          },
          required: ['key', 'value']
        },
        execute: async({ key, value }) => {
          this.context.set(key, value);
          return 'Success';
        }
      },
      {
        name: 'StoreGet',
        description: 'Read a value from the short-term context.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The key to retrieve' }
          },
          required: ['key']
        },
        execute: async({ key }) => this.context.has(key) ? this.context.get(key) : 'null'
      },
      {
        name: 'StoreList',
        description: 'Get a list of keys that are currently active in the short-term context.',
        input_schema: {
          type: 'object',
          properties: {}
        },
        execute: async() => Array.from(this.context.keys())
      },
      {
        name: 'StoreRm',
        description: 'Remove a value from the short-term context.',
        input_schema: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { type: 'string' },
              description: 'The keys to remove'
            }
          },
          required: ['keys']
        },
        execute: async({ keys }) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const key of keyList) this.context.delete(key);
          return 'Success';
        }
      }
    ]);
  }

  async _request(payload) {
    const res = await fetch('https://openrouter.ai/api/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...payload, stream: false })
    });

    let responseBody;
    try {
      responseBody = await res.json();
    } catch {
      try {
        responseBody = await res.arrayBuffer();
        responseBody = Buffer.from(responseBody).toString();
      } catch {}
    }

    return res.ok ?
      Promise.resolve(responseBody) :
      Promise.reject(responseBody);
  }

  async _send() {
    const payload = {
      model: this.model,
      messages: this.messages.slice(0, -1),
      system: this.system,
      tools: this.tools?.getDefinitions?.(),
      thinking: this.thinking,
      provider: this.provider,
      max_tokens: this.max_tokens,
      //stream: false
    };
    const lastMsg = this.messages.slice(-1)[0];

    // inject cache_control
    if (lastMsg.content.length > 0) {
      lastMsg.content[lastMsg.content.length - 1].cache_control = { type: 'ephemeral' };
    }
    payload.messages.push(lastMsg);

    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this._request(payload);
    logger.debug(`Received response from LLM.`);

    this.usage.cost += (response.usage?.cost || 0);
    this.usage.tokens += (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);

    // delete cache_control
    delete lastMsg.content[lastMsg.content.length - 1].cache_control;

    return response;
  }

  async use(tools) {
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        this.tools.register(tool);
      }
      return;
    }
    this.tools.register(tools);
  }

  async run(prompt, callback = () => null) {
    let response;
    let toolUses;

    if (prompt) {
      const contents = Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
      const lastIdx = this.messages.length - 1;

      if (this.messages[lastIdx]?.role === 'user') {
        this.messages[lastIdx].content.push(...contents);
      } else {
        this.messages.push({ role: 'user', content: contents });
      }
    }

    while (true) {
      response = await withRetry(() => this._send(), 5);
      callback(response.content);
      this.messages.push({ role: response.role, content: response.content });

      toolUses = response.content.filter(x => x.type === 'tool_use');
      if (!toolUses.length) break;

      const content = [];
      for (const tc of toolUses) {
        logger.debug(`Executing tool: ${tc.name}`);
        const result = await this.tools.execute(tc.name, tc.input, { agent: this });

        content.push({
          tool_use_id: tc.id,
          type: 'tool_result',
          content: (typeof result === 'string') ? result : JSON.stringify(result)
        });

        // Check for termination signal from finish_task
        if (tc.name === 'Report') {
          this.messages.push({ role: 'user', content });
          this.finalReport = tc.input; // { summary, artifacts }
          return this.finalReport;
        }
      }

      // Inject background terminal notifications
      const notifications = this.terminalManager.popNotifications();
      if (notifications.length) {
        content.push({
          type: 'text',
          text: `<system-reminder>\n${notifications.join('\n')}\n</system-reminder>`
        });
      }

      this.messages.push({ role: 'user', content });
    }

    return this.messages.slice(-1)[0].content;
  }
}

export default Agent;
