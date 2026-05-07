import { McpClientWrapper } from '../core/mcp.js';
import logger from '../core/logger.js';

export class ToolRegistry {
  _tools = new Map();
  _mcpClients = [];
  _hooks = { beforeExecute: [], afterExecute: [] };

  // Hook before tool execute — receives { name, input, context }, throw to abort. Returns disposer.
  onBeforeExecute(fn) {
    this._hooks.beforeExecute.push(fn);
    return () => {
      const idx = this._hooks.beforeExecute.indexOf(fn);
      if (idx !== -1) this._hooks.beforeExecute.splice(idx, 1);
    };
  }

  // Hook after tool execute — receives { name, input, context, result }, throw to discard result. Returns disposer.
  onAfterExecute(fn) {
    this._hooks.afterExecute.push(fn);
    return () => {
      const idx = this._hooks.afterExecute.indexOf(fn);
      if (idx !== -1) this._hooks.afterExecute.splice(idx, 1);
    };
  }

  getDefinitions() {
    const res = [];
    for (const [name, val] of this._tools) {
      res.push({
        type: 'function',
        function: {
          name,
          description: val.description,
          parameters: val.input_schema,
        },
      });
    }
    return res;
  }

  listTools() {
    const tools = [];
    for (const [name, val] of this._tools) {
      tools.push({
        name,
        description: val.description,
        input_schema: val.input_schema,
      });
    }
    return tools;
  }

  register({ name, description, input_schema, execute }) {
    if (typeof execute !== 'function') throw Error('Tool must have an execute function');
    this._tools.set(name, { description, input_schema, execute });
  }

  unregister(name) {
    return this._tools.delete(name);
  }

  clear() {
    this._tools.clear();
    this._mcpClients = [];
    this._hooks = { beforeExecute: [], afterExecute: [] };
  }

  async execute(name, input, context) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);

    // Run before-execute hooks (can throw to abort)
    for (const hook of this._hooks.beforeExecute) {
      await hook({ name, input, context });
    }

    // Validate input against schema
    if (tool.input_schema) {
      const { required = [], properties = {} } = tool.input_schema;
      for (const key of required) {
        if (input[key] === undefined || input[key] === null || input[key] === '') {
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

    const result = await tool.execute(input, context);

    // Run after-execute hooks (can throw to signal problems)
    for (const hook of this._hooks.afterExecute) {
      await hook({ name, input, context, result });
    }

    return result;
  }

  async connectMcpServer({ name, command, args, env }) {
    const client = new McpClientWrapper({ command, args, env });
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
    this._mcpClients.push(client);
  }

  async cleanup() {
    for (const client of this._mcpClients) {
      try {
        await client.close();
      } catch (err) {
        logger.warn('MCP client close failed:', err.message);
      }
    }
    this._mcpClients = [];
  }
}
