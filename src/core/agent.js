import { withRetry } from './utils.js';
import terminalManager from './terminal.js';
import logger from './logger.js';

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
    this.thinking = { type: 'adaptive' };
    this.usage = { cost: 0, tokens: 0 };
    this.finalReport = null; // Store subagent result
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

  async _send(messages) {
    const payload = {
      model: this.model,
      messages: messages.slice(0, -1),
      system: this.system,
      tools: this.tools?.getDefinitions?.(),
      thinking: this.thinking,
      provider: this.provider,
      //stream: false
    };
    const lastMsg = messages.slice(-1)[0];

    // inject cache_control
    if (lastMsg.content.length > 0) {
      lastMsg.content[lastMsg.content.length - 1].cache_control = { type: 'ephemeral' };
    }
    payload.messages.push(lastMsg);

    logger.debug(`Sending request to LLM (${this.model})...`);
    const response = await this._request(payload);
    logger.debug(`Received response from LLM.`);
    this.usage.cost += response.usage.cost;
    this.usage.tokens += response.usage.input_tokens + response.usage.output_tokens;

    // delete cache_control
    delete lastMsg.content[lastMsg.content.length - 1].cache_control;

    return response;
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
      response = await withRetry(() => this._send(this.messages), 5);
      callback(response.content); // suitable for capturing thoughts from LLM and displaying them as temporary messages
      this.messages.push({ role: response.role, content: response.content });

      toolUses = response.content.filter(x => x.type === 'tool_use');
      if (!toolUses.length) break;

      const content = [];
      for (const tc of toolUses) {
        logger.debug(`Executing tool: ${tc.name}`);
        // Pass 'this' as context to all tools
        const result = await this.tools.execute(tc.name, tc.input, { agent: this });

        content.push({
          tool_use_id: tc.id,
          type: 'tool_result',
          content: (typeof result === 'string') ? result : JSON.stringify(result)
        });

        // Check for termination signal from finish_task
        if (tc.name === 'FinishTask') {
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
