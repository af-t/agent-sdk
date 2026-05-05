import { McpClientWrapper } from './mcp.js';
import config from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import logger from './logger.js';

// Constants
export const CONSTANTS = Object.freeze({
  MAX_FILE_SIZE_SEARCH: 500 * 1024, // 500KB
  RETRY_BASE_DELAY: 5000,           // ms
  RETRY_BACKOFF_FACTOR: 1.3,
  MCP_TIMEOUT: 30000,               // ms
  FETCH_TIMEOUT: 15000,             // ms
  MAX_TOKENS_SUBAGENT: 32000,
});

// Cached gitignore filter
let _ignoreFilterCache = null;
let _ignoreFilterCacheKey = null;

export async function getIgnoreFilter() {
  const cwd = process.cwd();
  // Invalidate cache if cwd changed
  if (_ignoreFilterCache && _ignoreFilterCacheKey === cwd) {
    return _ignoreFilterCache;
  }

  const ig = ignore();
  try {
    const gitignorePath = path.join(cwd, '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf8');
    ig.add(content);
  } catch {
    logger.debug('.gitignore not found or unreadable, ignoring.');
  }

  _ignoreFilterCache = {
    test: (filePath) => {
      const relPath = path.relative(cwd, ensureSafePath(filePath));
      return ig.test(relPath);
    },
    ignores: (filePath) => {
      const relPath = path.relative(cwd, ensureSafePath(filePath));
      return ig.ignores(relPath);
    },
    add: (content) => ig.add(content)
  };
  _ignoreFilterCacheKey = cwd;

  return _ignoreFilterCache;
}

export function clearIgnoreFilterCache() {
  _ignoreFilterCache = null;
  _ignoreFilterCacheKey = null;
}

export function ensureSafePath(filePath) {
  const root = process.cwd();
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(root, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Access denied: Path '${filePath}' is outside project root`);
  }
  return resolvedPath;
}

export function formatSize(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

export async function withRetry(func, count = config.MAX_RETRIES, callback) {
  let delay = CONSTANTS.RETRY_BASE_DELAY;
  let lastError;

  for (let i = 0; i < count; i++) {
    try {
      const res = await func();
      return res;
    } catch (err) {
      // Add jitter: ±20% random variation to prevent thundering herd
      const jitter = delay * (0.8 + Math.random() * 0.4);
      await new Promise(resolve => setTimeout(resolve, jitter));
      lastError = err;
      delay *= CONSTANTS.RETRY_BACKOFF_FACTOR;
    }
  }

  callback?.();
  throw lastError;
}

export class ToolRegistry {
  _tools = new Map();
  _mcpClients = [];

  getDefinitions() {
    const res = [];
    for (const [name, val] of this._tools) {
      res.push({
        type: 'function',
        function: {
          name,
          description: val.description,
          parameters: val.input_schema
        }
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
        input_schema: val.input_schema
      });
    }
    return tools;
  }

  register({ name, description, input_schema, execute }) {
    if (typeof execute !== 'function') throw Error('tools cannot be executed');
    this._tools.set(name, { description, input_schema, execute });
  }

  async execute(name, input, context) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);

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
            throw new Error(`Tool '${name}': parameter '${key}' must be one of [${propSchema.enum.join(', ')}], got '${value}'`);
          }
        }
      }
    }

    return await tool.execute(input, context);
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
            throw new Error(result.content.map(c => c.text).join('\n'));
          }
          return result.content.map(c => {
             if (c.type === 'text') return c.text;
             if (c.type === 'resource') return `[Resource: ${c.resource.uri}]`;
             return JSON.stringify(c);
          }).join('\n');
        }
      });
    }
    this._mcpClients.push(client);
  }

  async cleanup() {
    for (const client of this._mcpClients) {
      try {
        await client.close();
      } catch (err) {
      }
    }
    this._mcpClients = [];
  }
}

async function isDirectory(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function* loadTools(dirPath) {
  if (!(await isDirectory(dirPath))) return;

  logger.debug(`Loading tools from: ${dirPath}`);
  const entries = (await fs.readdir(dirPath, { recursive: true, withFileTypes: true })).filter(x => x.isFile());
  for (const entry of entries) {
    const fullPath = path.resolve(path.join(entry.parentPath, entry.name));
    try {
      const mod = await import(fullPath);
      const tool = {
        name: mod.name || mod.default?.name,
        description: mod.description || mod.default?.description,
        input_schema: mod.input_schema || mod.default?.input_schema,
        execute: mod.execute || mod.default?.execute
      };

      if (!tool.name || !tool.input_schema || !tool.execute) {
        throw Error(`File '${entry.name}' does not have mandatory properties`);
      }

      logger.debug(`Tool loaded: ${tool.name}`);
      yield tool;
    } catch (err) {
      logger.error(`Failed to load tool from ${entry.name}: ${err.message}`);
    }
  }
}
