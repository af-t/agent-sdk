import config from '../config.js';
import fs from 'node:fs/promises';
import { realpathSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ignore from 'ignore';
import logger from './logger.js';

// Constants
export const CONSTANTS = Object.freeze({
  MAX_FILE_SIZE_SEARCH: 500 * 1024, // 500KB
  RETRY_BASE_DELAY_MS: 5000, // ms
  RETRY_BACKOFF_FACTOR: 1.3,
  MCP_TIMEOUT: 30000, // ms
  FETCH_TIMEOUT_MS: 15000, // ms
  FETCH_MAX_SIZE: 10 * 1024 * 1024, // 10MB — response body limit for WebFetch
  MAX_TOKENS_SUBAGENT: 32000,
});

export function getDirname(importMeta) {
  return importMeta.dirname || path.dirname(fileURLToPath(importMeta.url));
}

// Cached gitignore filter
let _ignoreFilterCache = null;
let _ignoreFilterCacheKey = null;
let _ignoreFilterMtime = 0;

export async function getIgnoreFilter() {
  const cwd = process.cwd();
  const gitignorePath = path.join(cwd, '.gitignore');
  let mtime = 0;
  try {
    mtime = statSync(gitignorePath).mtimeMs;
  } catch {}

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
    add: (content) => ig.add(content),
  };
  _ignoreFilterCacheKey = cwd;

  return _ignoreFilterCache;
}

export function clearIgnoreFilterCache() {
  _ignoreFilterCache = null;
  _ignoreFilterCacheKey = null;
  _ignoreFilterMtime = 0;
}

// URL-decode, return original on failure
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
  let decoded = filePath;
  let iterations = 0;
  while (decoded.includes('%') && iterations < 3) {
    decoded = tryDecodeURIComponent(decoded);
    iterations++;
  }

  if (
    /%2e%2e|%2f|%5c/i.test(filePath) ||
    decoded.includes('..') ||
    (filePath.includes('%') && (decoded.includes('/') || decoded.includes('\\')))
  ) {
    throw new Error(`Access denied: Path contains URL-encoded traversal characters`);
  }

  // 3. Reject protocol handlers (file://, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath.trim())) {
    throw new Error(`Access denied: Path uses a protocol handler`);
  }

  const root = path.resolve(process.cwd());
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(root, resolvedPath);

  // 4. Must be within project root
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Access denied: Path '${filePath}' is outside project root`);
  }

  // 5. Resolve symlinks to prevent TOCTOU (time-of-check-time-of-use)
  try {
    const stats = lstatSync(resolvedPath);
    if (stats.isSymbolicLink()) {
      let realPath;
      try {
        realPath = realpathSync(resolvedPath);
      } catch {
        // Broken symlink — check its raw target
        const target = readlinkSync(resolvedPath);
        realPath = path.resolve(path.dirname(resolvedPath), target);
      }
      const relativeReal = path.relative(root, realPath);
      if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
        throw new Error(`Access denied: Path '${filePath}' resolves outside project root`);
      }
      return realPath;
    }
    // Not a symlink, but realpathSync still helps normalize things like /./ or //
    const realPath = realpathSync(resolvedPath);
    const relativeReal = path.relative(root, realPath);
    if (relativeReal.startsWith('..') || path.isAbsolute(relativeReal)) {
      throw new Error(`Access denied: Path '${filePath}' resolves outside project root`);
    }
    return realPath;
  } catch (err) {
    if (err.message.startsWith('Access denied')) throw err;
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

// Sensitive env var substrings (case-insensitive) — stripped from child process environments
const SENSITIVE_ENV_PATTERNS = [
  'api_key',
  'apikey',
  'api-key',
  'secret',
  'token',
  'password',
  'credential',
  'auth',
  'openrouter',
  'tavily',
  'private_key',
  'privatekey',
];

// Strip sensitive env vars, return safe copy
export function stripSecrets(env) {
  const safe = {};
  for (const [key, value] of Object.entries(env)) {
    const keyLower = key.toLowerCase();
    const isSensitive = SENSITIVE_ENV_PATTERNS.some((pattern) => keyLower.includes(pattern));
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
      await new Promise((resolve) => setTimeout(resolve, Math.min(jitter, MAX_DELAY)));
      lastError = err;
      delay = Math.min(delay * CONSTANTS.RETRY_BACKOFF_FACTOR, MAX_DELAY);
    }
  }

  // Call the failure callback with a 5-second safety timeout.
  // If the callback hangs, we proceed after timeout.
  if (callback) {
    try {
      const callbackPromise = callback();
      // If callback returns a promise, guard it with a timeout
      if (callbackPromise && typeof callbackPromise.then === 'function') {
        await Promise.race([
          callbackPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Callback timed out')), 5000)),
        ]);
      }
    } catch (err) {
      logger.warn('withRetry failure callback failed:', err.message);
    }
  }

  throw lastError;
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
  const entries = (await fs.readdir(dirPath, { recursive: true, withFileTypes: true })).filter((x) => x.isFile());
  for (const entry of entries) {
    const fullPath = path.resolve(path.join(entry.parentPath, entry.name));
    try {
      const mod = await import(fullPath);
      const tool = {
        name: mod.name || mod.default?.name,
        description: mod.description || mod.default?.description,
        input_schema: mod.input_schema || mod.default?.input_schema,
        execute: mod.execute || mod.default?.execute,
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
