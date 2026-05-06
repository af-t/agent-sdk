import { McpClientWrapper } from './mcp.js';
import config from '../config.js';
import fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import logger from './logger.js';

// Constants
export const CONSTANTS = Object.freeze({
  MAX_FILE_SIZE_SEARCH: 500 * 1024, // 500KB
  RETRY_BASE_DELAY_MS: 5000,        // ms
  RETRY_BACKOFF_FACTOR: 1.3,
  MCP_TIMEOUT: 30000,               // ms
  FETCH_TIMEOUT_MS: 15000,          // ms
  FETCH_MAX_SIZE: 10 * 1024 * 1024, // 10MB — response body limit for WebFetch
  MAX_TOKENS_SUBAGENT: 32000,
});

// Cached gitignore filter
let _ignoreFilterCache = null;
let _ignoreFilterCacheKey = null;
let _ignoreFilterMtime = 0;

export async function getIgnoreFilter() {
  const cwd = process.cwd();
  const gitignorePath = path.join(cwd, '.gitignore');
  let mtime = 0;
  try { mtime = statSync(gitignorePath).mtimeMs; } catch {}

  // Invalidate cache if cwd changed or .gitignore was modified
  if (_ignoreFilterCache && _ignoreFilterCacheKey === cwd && _ignoreFilterMtime === mtime) {
    return _ignoreFilterCache;
  }
  _ignoreFilterMtime = mtime;

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
  _ignoreFilterMtime = 0;
}

/**
 * Safely URL-decode a string, returning the original on failure.
 */
function tryDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

export function ensureSafePath(filePath) {
  // 1. Reject null bytes (CVE-2021-3805 style bypass)
  if (filePath.includes('\0')) {
    throw new Error(`Access denied: Path contains null byte`);
  }

  // 2. Reject URL-encoded path traversal (double encoding attacks)
  // Decode first to catch %2e%2e (..), then check for raw traversal
  const decoded = filePath.includes('%') ? tryDecodeURIComponent(filePath) : filePath;
  if (/%2e%2e|%2f|%5c/i.test(filePath) || decoded.includes('..')) {
    throw new Error(`Access denied: Path contains URL-encoded traversal characters`);
  }

  // 3. Reject protocol handlers (file://, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath.trim())) {
    throw new Error(`Access denied: Path uses a protocol handler`);
  }

  const root = path.resolve(process.cwd());
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(root, resolvedPath);

  // 4. Must be within project root (empty string = outside — path IS the root)
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) {
    throw new Error(`Access denied: Path '${filePath}' is outside project root`);
  }

  // 5. Resolve symlinks to prevent TOCTOU (time-of-check-time-of-use)
  try {
    return realpathSync(resolvedPath);
  } catch {
    // Path doesn't exist yet (valid for Write tool); validate parent directory
    const dir = path.dirname(resolvedPath);
    try {
      const safeDir = realpathSync(dir);
      const safeRelative = path.relative(root, safeDir);
      if (safeRelative.startsWith('..') || path.isAbsolute(safeRelative)) {
        throw new Error(`Access denied: Path '${filePath}' resolves outside project root`);
      }
    } catch (dirErr) {
      if (dirErr.message.startsWith('Access denied')) throw dirErr;
      // Directory doesn't exist either — allow it, will be created by Write tool
    }
    return resolvedPath;
  }
}

/**
 * Sensitive env var name patterns to strip from child process environments.
 * These match any env var containing these substrings (case-insensitive).
 */
const SENSITIVE_ENV_PATTERNS = [
  'api_key', 'apikey', 'api-key',
  'secret', 'token', 'password',
  'credential', 'auth',
  'openrouter', 'tavily',
  'private_key', 'privatekey',
];

/**
 * Strip sensitive environment variables from an env object.
 * Returns a new object with only safe variables.
 * Also redacts known secret name patterns.
 */
export function stripSecrets(env) {
  const safe = {};
  for (const [key, value] of Object.entries(env)) {
    const keyLower = key.toLowerCase();
    const isSensitive = SENSITIVE_ENV_PATTERNS.some(pattern => keyLower.includes(pattern));
    if (!isSensitive) {
      safe[key] = value;
    }
  }
  return safe;
}

export function formatSize(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

export async function withRetry(func, count = config.MAX_RETRIES, callback) {
  let delay = CONSTANTS.RETRY_BASE_DELAY_MS;
  let lastError;
  const NON_RETRYABLE = [401, 403, 400, 404];
  const MAX_DELAY = 60_000; // 1 minute cap

  for (let i = 0; i < count; i++) {
    try {
      const res = await func();
      return res;
    } catch (err) {
      // Do not retry client errors (4xx except 429)
      if (err?.status && NON_RETRYABLE.includes(err.status)) {
        throw err;
      }
      // Add jitter: ±20% random variation to prevent thundering herd
      const jitter = delay * (0.8 + Math.random() * 0.4);
      await new Promise(resolve => setTimeout(resolve, Math.min(jitter, MAX_DELAY)));
      lastError = err;
      delay = Math.min(delay * CONSTANTS.RETRY_BACKOFF_FACTOR, MAX_DELAY);
    }
  }

  callback?.();
  throw lastError;
}

export class ToolRegistry {
  _tools = new Map();
  _mcpClients = [];
  _hooks = { beforeExecute: [], afterExecute: [] };

  /**
   * Register a hook that runs before every tool execution.
   * Receives { name, input, context }. Throw to abort the tool call.
   * Returns a disposer function to unregister the hook.
   */
  onBeforeExecute(fn) {
    this._hooks.beforeExecute.push(fn);
    return () => {
      const idx = this._hooks.beforeExecute.indexOf(fn);
      if (idx !== -1) this._hooks.beforeExecute.splice(idx, 1);
    };
  }

  /**
   * Register a hook that runs after every successful tool execution.
   * Receives { name, input, context, result }. Throw to signal a problem
   * (the tool result is discarded and the error propagates).
   * Returns a disposer function to unregister the hook.
   */
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
            throw new Error(`Tool '${name}': parameter '${key}' must be one of [${propSchema.enum.join(', ')}], got '${value}'`);
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
        logger.warn('MCP client close failed:', err.message);
      }
    }
    this._mcpClients = [];
  }
}

async function isDirectory(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch (err) {
    logger.debug('isDirectory stat failed:', err.message);
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
