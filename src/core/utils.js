import config from '../config.js';
import fs from 'node:fs/promises';
import { realpathSync, lstatSync, readlinkSync } from 'node:fs';
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
  MAX_COMPLETION_TOKENS_SUBAGENT: 32000,
  MAX_TOOL_OUTPUT: 50_000,
});

export function truncateOutput(text, maxChars = CONSTANTS.MAX_TOOL_OUTPUT) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n[... truncated: ${text.length - maxChars} characters omitted]`;
}

// true if any tool-role message has a non-text content part
export function payloadHasMultimodal(payload) {
  if (!payload || !Array.isArray(payload.messages)) return false;
  for (const msg of payload.messages) {
    if (msg.role !== 'tool' && msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;
    if (msg.content.some((part) => part && typeof part === 'object' && part.type !== 'text')) return true;
  }
  return false;
}

// strip non-text parts from user and tool messages; mutates payload.messages slots
export function degradePayload(payload) {
  if (!payload || !Array.isArray(payload.messages)) return;
  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];
    if (msg.role !== 'tool' && msg.role !== 'user') continue;
    if (!Array.isArray(msg.content)) continue;
    if (!msg.content.some((part) => part && typeof part === 'object' && part.type !== 'text')) continue;
    const textParts = msg.content.filter((part) => part && (typeof part === 'string' || part.type === 'text'));
    const content =
      textParts.length > 0
        ? textParts.map((p) => (typeof p === 'string' ? p : p.text)).join('\n')
        : '[non-text content omitted]';
    payload.messages[i] = { ...msg, content };
  }
}

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
    mtime = (await fs.stat(gitignorePath)).mtimeMs;
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
      const relPath = path.relative(cwd, path.resolve(filePath));
      if (relPath.startsWith('..' + path.sep) || relPath === '..') return false;
      return ig.test(relPath);
    },
    ignores: (filePath) => {
      const relPath = path.relative(cwd, path.resolve(filePath));
      if (relPath.startsWith('..' + path.sep) || relPath === '..') return false;
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

export function ensureSafePath(filePath, allowedRoots = new Set(), options = {}) {
  const restricted = options.restricted !== false;

  // 1. Reject null bytes
  if (filePath.includes('\0')) {
    throw new Error('Access denied: Path contains null byte');
  }

  // 2. Reject URL-encoded path traversal
  let decoded = filePath;
  let iterations = 0;
  while (decoded.includes('%') && iterations < 3) {
    decoded = tryDecodeURIComponent(decoded);
    iterations++;
  }
  if (
    /%2e%2e|%2f|%5c/i.test(filePath) ||
    (filePath.includes('%') && (decoded.includes('/') || decoded.includes('\\'))) ||
    (restricted && decoded.includes('..'))
  ) {
    throw new Error('Access denied: Path contains URL-encoded traversal characters');
  }

  // 3. Reject protocol handlers
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath.trim())) {
    throw new Error('Access denied: Path uses a protocol handler');
  }

  // 4. Resolve path to absolute string representation
  const resolvedTarget = path.resolve(filePath);

  // 5. Traverse up component-by-component to find the closest existing ancestor (guarantees symlink resolution)
  let current = resolvedTarget;
  let existingAncestor = null;
  let nonExistentSuffix = '';

  while (true) {
    try {
      existingAncestor = realpathSync(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        break; // Reached system root
      }
      nonExistentSuffix = path.join(path.basename(current), nonExistentSuffix);
      current = parent;
    }
  }

  if (!existingAncestor) {
    throw new Error('Access denied: Could not resolve path ancestor');
  }

  if (restricted) {
    const safeAllowedRoots = allowedRoots || new Set();

    // Helper to safely verify containment
    const isContained = (canonicalTarget, canonicalRoot) => {
      const isWindows = process.platform === 'win32';
      let t = canonicalTarget.normalize('NFC');
      let r = canonicalRoot.normalize('NFC');
      if (isWindows) {
        t = t.toLowerCase();
        r = r.toLowerCase();
      }
      const needle = r.endsWith(path.sep) ? r : r + path.sep;
      return t === r || t.startsWith(needle);
    };

    const canonicalProjectRoot = realpathSync(process.cwd());

    // Check if the next component after existingAncestor is a symlink (broken or not)
    const parts = nonExistentSuffix.split(path.sep).filter(Boolean);
    let isSymlinkBypass = false;
    let symlinkError = null;
    if (parts.length > 0) {
      const nextComponentPath = path.join(existingAncestor, parts[0]);
      try {
        const stats = lstatSync(nextComponentPath);
        if (stats.isSymbolicLink()) {
          let realTarget;
          try {
            realTarget = realpathSync(nextComponentPath);
          } catch {
            const rawTarget = readlinkSync(nextComponentPath);
            realTarget = path.resolve(existingAncestor, rawTarget);
          }
          if (!isContained(realTarget, canonicalProjectRoot)) {
            let allowed = false;
            for (const allowedRoot of safeAllowedRoots) {
              if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) continue;
              try {
                const canonicalAllowed = realpathSync(allowedRoot);
                if (isContained(realTarget, canonicalAllowed)) {
                  allowed = true;
                  break;
                }
              } catch {}
            }
            if (!allowed) {
              isSymlinkBypass = true;
              // Determine if it was inside a trusted root to throw correct error type
              for (const allowedRoot of safeAllowedRoots) {
                if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) continue;
                try {
                  const canonicalAllowed = realpathSync(allowedRoot);
                  if (isContained(nextComponentPath, canonicalAllowed)) {
                    symlinkError = new Error(`Access denied: Path '${filePath}' resolves outside trusted root`);
                  }
                } catch {}
              }
              if (!symlinkError) {
                symlinkError = new Error(`Access denied: Path '${filePath}' is outside project root`);
              }
            }
          }
        }
      } catch {
        // Safe, doesn't exist
      }
    }
    if (isSymlinkBypass && symlinkError) {
      throw symlinkError;
    }

    // 6. Verify containment against canonical project root
    const isTargetInProject = isContained(resolvedTarget, canonicalProjectRoot);
    let isSafe = isContained(existingAncestor, canonicalProjectRoot);

    // 7. Verify containment against canonical allowed roots
    let isTargetInAllowed = false;
    if (!isSafe) {
      for (const allowedRoot of safeAllowedRoots) {
        if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) continue;
        try {
          const canonicalAllowed = realpathSync(allowedRoot);
          if (isContained(resolvedTarget, canonicalAllowed)) {
            isTargetInAllowed = true;
          }
          if (isContained(existingAncestor, canonicalAllowed)) {
            isSafe = true;
            break;
          }
        } catch {
          // Allowed root doesn't exist, ignore
        }
      }
    }

    if (!isSafe) {
      if (isTargetInAllowed && !isTargetInProject) {
        throw new Error(`Access denied: Path '${filePath}' resolves outside trusted root`);
      }
      throw new Error(`Access denied: Path '${filePath}' is outside project root`);
    }
  }

  // Return the secure, resolved path
  return path.join(existingAncestor, nonExistentSuffix);
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

// Env vars that hijack the dynamic linker or a language runtime
const UNSAFE_ENV_KEYS = new Set([
  // dynamic linker / loader (Linux + macOS) — LD_PRELOAD host passthrough handled by SAFE_ENV_KEYS
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_PROFILE',
  'LD_ORIGIN_PATH',
  'GCONV_PATH',
  'NLSPATH',
  'LOCPATH',
  'HOSTALIASES',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  // shell startup / parsing
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'PS4',
  'IFS',
  'PROMPT_COMMAND',
  // language runtimes
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'PYTHONHOME',
  'PERL5LIB',
  'PERL5OPT',
  'PERLLIB',
  'PERL5DB',
  'RUBYOPT',
  'RUBYLIB',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
  'PHPRC',
  'PHP_INI_SCAN_DIR',
]);

// Strip secrets plus loader/runtime hijack vars from caller-supplied env
export function stripUnsafeEnv(env) {
  const safe = {};
  for (const [key, value] of Object.entries(stripSecrets(env))) {
    const upper = key.toUpperCase();
    if (UNSAFE_ENV_KEYS.has(upper)) continue;
    if (upper.startsWith('BASH_FUNC_')) continue;
    safe[key] = value;
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
  const MAX_DELAY = 60_000; // 1 minute cap

  for (let i = 0; i < count; i++) {
    try {
      const res = await func();
      return res;
    } catch (err) {
      // Do not retry caller-initiated aborts
      if (err?.aborted) {
        throw err;
      }
      // Do not retry client errors (4xx except 429 and 408)
      if (err?.status && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 408) {
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
        let timerId;
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(() => reject(new Error('Callback timed out')), 5000);
        });
        try {
          await Promise.race([callbackPromise, timeoutPromise]);
        } finally {
          clearTimeout(timerId);
        }
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


