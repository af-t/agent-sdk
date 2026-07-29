import { McpClientWrapper } from '../integrations/mcp-client.js';
import { ToolError } from '../support/errors.js';
import { LIMITS, truncateOutput } from '../support/payload.js';
import { resolveLogger } from '../support/logger.js';

const DEFAULT_INPUT_SCHEMA = Object.freeze({ type: 'object', properties: {} });
const UNSUPPORTED_INPUT_SCHEMA_KEY = ['input', 'schema'].join('_');
const UNSUPPORTED_OUTPUT_LIMIT_KEY = ['output', 'limit'].join('_');

function validateToolInput(inputSchema, input, toolName, { allowOutputLimit = false } = {}) {
  const { required = [], properties = {} } = inputSchema || DEFAULT_INPUT_SCHEMA;
  for (const name of required) {
    if (input[name] === undefined || input[name] === null) {
      throw new ToolError(`Parameter "${name}" is required`, { toolName });
    }
  }
  for (const [name, value] of Object.entries(input)) {
    if (name === 'outputLimit' && allowOutputLimit) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ToolError('Parameter "outputLimit" must be a finite number', { toolName });
      }
      continue;
    }
    const property = properties[name];
    if (!property) {
      if (inputSchema.additionalProperties === false) {
        throw new ToolError(`Unsupported parameter "${name}"`, { toolName });
      }
      continue;
    }
    if (value === undefined || value === null) continue;
    const valid =
      !property.type ||
      (property.type === 'array'
        ? Array.isArray(value)
        : property.type === 'object'
          ? typeof value === 'object' && !Array.isArray(value)
          : typeof value === property.type);
    if (!valid) {
      const article = property.type === 'array' || property.type === 'object' ? 'an' : 'a';
      throw new ToolError(`Parameter "${name}" must be ${article} ${property.type}`, { toolName });
    }
    if (property.enum && !property.enum.includes(value)) {
      throw new ToolError(`Parameter "${name}" must be one of [${property.enum.join(', ')}]`, { toolName });
    }
    if (property.type === 'object') validateToolInput(property, value, toolName);
    if (property.type === 'array' && property.items) {
      for (const item of value) {
        if (property.items.type === 'object') validateToolInput(property.items, item, toolName);
      }
    }
  }
}

export class ToolRegistry {
  #tools = new Map();
  #mcpClients = [];
  #hooks = { beforeExecute: [], afterExecute: [] };

  constructor({ restricted = true, logger, mcpClientFactory } = {}) {
    this.restricted = restricted !== false;
    this.logger = resolveLogger(logger).child({ component: 'toolRegistry' });
    this.mcpClientFactory = mcpClientFactory || ((config) => new McpClientWrapper(config));
  }

  onBeforeExecute(callback) {
    this.#hooks.beforeExecute.push(callback);
    return () => {
      const index = this.#hooks.beforeExecute.indexOf(callback);
      if (index !== -1) this.#hooks.beforeExecute.splice(index, 1);
    };
  }

  onAfterExecute(callback) {
    this.#hooks.afterExecute.push(callback);
    return () => {
      const index = this.#hooks.afterExecute.indexOf(callback);
      if (index !== -1) this.#hooks.afterExecute.splice(index, 1);
    };
  }

  register(tool) {
    if (Object.hasOwn(tool || {}, UNSUPPORTED_INPUT_SCHEMA_KEY))
      throw new Error(`Unsupported key: ${UNSUPPORTED_INPUT_SCHEMA_KEY}`);
    if (Object.hasOwn(tool || {}, UNSUPPORTED_OUTPUT_LIMIT_KEY))
      throw new Error(`Unsupported key: ${UNSUPPORTED_OUTPUT_LIMIT_KEY}`);
    const { name, description, inputSchema = DEFAULT_INPUT_SCHEMA, execute } = tool || {};
    if (typeof name !== 'string') throw new Error('Tool must have a name');
    if (typeof description !== 'string') throw new Error('Tool must have a description');
    if (!inputSchema || typeof inputSchema !== 'object') throw new Error('Tool must have an inputSchema object');
    if (typeof execute !== 'function') throw new Error('Tool must have an execute function');
    this.#tools.set(name, { name, description, inputSchema, execute });
  }

  registerMany(tools) {
    for (const tool of tools) this.register(tool);
  }
  unregister(name) {
    return this.#tools.delete(name);
  }
  clear() {
    this.#tools.clear();
    this.#hooks = { beforeExecute: [], afterExecute: [] };
  }

  getDefinitions(names) {
    const definitions = [];
    for (const tool of this.#tools.values()) {
      if (Array.isArray(names) && !names.includes(tool.name)) continue;
      definitions.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            ...tool.inputSchema,
            properties: {
              ...(tool.inputSchema.properties || {}),
              outputLimit: { type: 'number', description: 'Maximum characters returned from this tool call.' },
            },
          },
        },
      });
    }
    return definitions;
  }

  listTools() {
    return [...this.#tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async execute(name, input = {}, context = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new ToolError(`Tool "${name}" is not registered`, { toolName: name });
    if (Object.hasOwn(input, UNSUPPORTED_OUTPUT_LIMIT_KEY))
      throw new ToolError(`Unsupported key: ${UNSUPPORTED_OUTPUT_LIMIT_KEY}`, { toolName: name });
    const executionContext = {
      ...context,
      agent: context.agent || { restricted: this.restricted, trustedPaths: new Set() },
      logger: context.logger ?? this.logger.child({ tool: name }),
      signal: context.signal ?? new AbortController().signal,
    };
    validateToolInput(tool.inputSchema, input, name, { allowOutputLimit: true });
    const { outputLimit, ...toolInput } = input;
    const limit =
      outputLimit ??
      executionContext.maxToolOutput ??
      executionContext.agent?.maxToolOutputChars ??
      LIMITS.maxToolOutput;
    for (const hook of this.#hooks.beforeExecute) {
      const hookResult = await hook({ name, input, context: executionContext });
      if (hookResult && typeof hookResult === 'object' && 'override' in hookResult)
        return truncateOutput(hookResult.override, limit);
    }
    let output;
    try {
      output = await tool.execute(toolInput, executionContext);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error.message || String(error), { toolName: name, cause: error });
    }
    for (const hook of this.#hooks.afterExecute) await hook({ name, input, context: executionContext, result: output });
    return truncateOutput(output, limit);
  }

  async connectMcpServer({ name, command, args, env }) {
    const client = this.mcpClientFactory({
      name,
      server: name,
      command,
      args,
      env,
      restricted: this.restricted,
      logger: this.logger,
    });
    try {
      const remoteTools = await client.connectAndGetTools();
      for (const remoteTool of remoteTools) {
        this.register({
          name: `${name}.${remoteTool.name}`,
          description: remoteTool.description || `Tool ${remoteTool.name} from ${name}`,
          inputSchema: remoteTool.inputSchema || DEFAULT_INPUT_SCHEMA,
          execute: async (input, context) => {
            const result = await client.executeTool(remoteTool.name, input, { signal: context.signal });
            if (result.isError) throw new Error(result.content.map((content) => content.text).join('\n'));
            return result.content
              .map((content) =>
                content.type === 'text'
                  ? content.text
                  : content.type === 'resource'
                    ? `[Resource: ${content.resource.uri}]`
                    : JSON.stringify(content),
              )
              .join('\n');
          },
        });
      }
      this.#mcpClients.push(client);
    } catch (error) {
      try {
        await client.close();
      } catch (closeError) {
        this.logger.warn({ server: name, error: closeError }, 'Failed to close MCP client after connection failure');
      }
      throw error;
    }
  }

  async cleanup() {
    for (const client of this.#mcpClients) {
      try {
        await client.close();
      } catch (error) {
        this.logger.warn({ server: client.server, error }, 'Failed to close MCP client');
      }
    }
    this.#mcpClients = [];
  }
}
