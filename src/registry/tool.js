import { McpClientWrapper } from '../core/mcp.js';
import logger from '../core/logger.js';
import { truncateOutput, CONSTANTS } from '../core/utils.js';

export class ToolRegistry {
  #tools = new Map();
  #mcpClients = [];
  #hooks = { beforeExecute: [], afterExecute: [] };

  constructor(options = {}) {
    this.restricted = options.restricted !== false;
  }

  // throw to abort; returns disposer
  onBeforeExecute(fn) {
    this.#hooks.beforeExecute.push(fn);
    return () => {
      const idx = this.#hooks.beforeExecute.indexOf(fn);
      if (idx !== -1) this.#hooks.beforeExecute.splice(idx, 1);
    };
  }

  // throw to discard result; returns disposer
  onAfterExecute(fn) {
    this.#hooks.afterExecute.push(fn);
    return () => {
      const idx = this.#hooks.afterExecute.indexOf(fn);
      if (idx !== -1) this.#hooks.afterExecute.splice(idx, 1);
    };
  }

  getDefinitions(filter) {
    const res = [];
    const push = (name, val) => {
      const schema = val.input_schema || { type: 'object', properties: {} };
      res.push({
        type: 'function',
        function: {
          name,
          description: val.description,
          parameters: {
            ...schema,
            properties: {
              ...(schema.properties || {}),
              output_limit: {
                type: 'number',
                description: 'Maximum characters to return from this tool call. Overrides the agent default.',
              },
            },
          },
        },
      });
    };

    for (const [name, val] of this.#tools) {
      if (filter && Array.isArray(filter)) {
        if (filter.includes(name)) push(name, val);
      } else {
        push(name, val);
      }
    }

    return res;
  }

  listTools() {
    const tools = [];
    for (const [name, val] of this.#tools) {
      tools.push({
        name,
        description: val.description,
        input_schema: val.input_schema,
      });
    }
    return tools;
  }

  register({ name, description, input_schema, execute }) {
    if (name == null || typeof name !== 'string') throw Error('Tool must have a name');
    if (description == null || typeof description !== 'string') throw Error('Tool must have a description');
    if (typeof execute !== 'function') throw Error('Tool must have an execute function');
    this.#tools.set(name, { description, input_schema, execute });
  }

  unregister(name) {
    return this.#tools.delete(name);
  }

  clear() {
    this.#tools.clear();
    this.#mcpClients = [];
    this.#hooks = { beforeExecute: [], afterExecute: [] };
  }

  async execute(name, input, context) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);

    // Ensure ctx.signal is always defined so tool code can rely on it
    const ctx = { ...context, signal: context?.signal ?? new AbortController().signal };

    // Run before-execute hooks (can throw to abort)
    for (const hook of this.#hooks.beforeExecute) {
      await hook({ name, input, context: ctx });
    }

    // Validate input against schema
    if (tool.input_schema) {
      const { required = [], properties = {} } = tool.input_schema;
      for (const key of required) {
        if (input[key] === undefined || input[key] === null) {
          throw new Error(`Tool '${name}' requires parameter '${key}'`);
        }
      }
      // Type check for provided parameters
      for (const [key, value] of Object.entries(input)) {
        const propSchema = properties[key];
        if (propSchema && value !== undefined && value !== null) {
          if (propSchema.type === 'number' && typeof value !== 'number') {
            throw new Error(`Tool '${name}': parameter '${key}' must be a number, got ${typeof value}`);
          }
          if (propSchema.type === 'string' && typeof value !== 'string') {
            throw new Error(`Tool '${name}': parameter '${key}' must be a string, got ${typeof value}`);
          }
          if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
            throw new Error(`Tool '${name}': parameter '${key}' must be a boolean, got ${typeof value}`);
          }
          if (propSchema.type === 'array' && !Array.isArray(value)) {
            throw new Error(`Tool '${name}': parameter '${key}' must be an array, got ${typeof value}`);
          }
          if (propSchema.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
            throw new Error(`Tool '${name}': parameter '${key}' must be an object, got ${typeof value}`);
          }
          if (propSchema.enum && !propSchema.enum.includes(value)) {
            throw new Error(
              `Tool '${name}': parameter '${key}' must be one of [${propSchema.enum.join(', ')}], got '${value}'`,
            );
          }
        }
      }
    }

    const { output_limit, ...cleanInput } = input;
    const limit = output_limit ?? ctx?.agent?.maxToolOutputChars ?? CONSTANTS.MAX_TOOL_OUTPUT;

    const result = await tool.execute(cleanInput, ctx);

    // Run after-execute hooks (can throw to signal problems)
    for (const hook of this.#hooks.afterExecute) {
      await hook({ name, input, context: ctx, result });
    }

    return truncateOutput(result, limit);
  }

  async connectMcpServer({ name, command, args, env }) {
    const client = new McpClientWrapper({ command, args, env, restricted: this.restricted });
    try {
      const remoteTools = await client.connectAndGetTools();

      for (const remoteTool of remoteTools) {
        const toolName = `${name}_${remoteTool.name}`;

        this.register({
          name: toolName,
          description: remoteTool.description || `Tool ${remoteTool.name} from ${name}`,
          input_schema: remoteTool.inputSchema || { type: 'object', properties: {} },
          execute: async (input) => {
            const result = await client.executeTool(remoteTool.name, input);
            if (result.isError) {
              throw new Error(result.content.map((c) => c.text).join('\n'));
            }
            return result.content
              .map((c) => {
                if (c.type === 'text') return c.text;
                if (c.type === 'resource') return `[Resource: ${c.resource.uri}]`;
                return JSON.stringify(c);
              })
              .join('\n');
          },
        });
      }
      this.#mcpClients.push(client);
    } catch (err) {
      try {
        await client.close();
      } catch (closeErr) {
        logger.warn(`Failed to close MCP client after connection failure: ${closeErr.message}`);
      }
      throw err;
    }
  }

  async cleanup() {
    for (const client of this.#mcpClients) {
      try {
        await client.close();
      } catch (err) {
        logger.warn('MCP client close failed:', err.message);
      }
    }
    this.#mcpClients = [];
  }
}
