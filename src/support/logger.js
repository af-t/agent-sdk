import { ConfigError } from './errors.js';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const SECRET_KEY_PATTERN = /authorization|api[_-]?key|secret|token|password|(?:auth|credentials?)$/i;
const SECRET_PATTERNS = [
  /(Authorization:\s*(?:Bearer|Basic)\s+)[a-zA-Z0-9+/=._-]+/gi,
  /(Bearer\s+)[a-zA-Z0-9._-]+/g,
  /(\bsk-(?:[a-zA-Z0-9]+-)?)[a-zA-Z0-9_-]+/g,
  /(tvly-)[a-zA-Z0-9_-]+/g,
  /([?&](?:api_key|key|token|apikey)=)[^&\s]+/gi,
  /((?:API_KEY|SECRET|TOKEN|PASSWORD)[^=]*=\s*['"]?)[^'"\s]+/gi,
];

function redactString(value) {
  if (typeof value !== 'string') return value;

  return SECRET_PATTERNS.reduce((redacted, pattern) => {
    return redacted.replace(pattern, (_, prefix) => `${prefix}[REDACTED]`);
  }, value);
}

export function redactLogValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      code: value.code,
      stack: redactString(value.stack),
    };
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  const output = Array.isArray(value) ? [] : {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactLogValue(entry, seen);
  }
  return output;
}

function validateLogger(logger) {
  for (const level of LEVELS) {
    if (typeof logger?.[level] !== 'function') {
      throw new ConfigError(`Logger must provide ${level}(context, message)`);
    }
  }
}

export function createDefaultLogger({ debug = false, consoleTarget = console } = {}) {
  const write = (level, context = {}, message = '') => {
    if (level === 'debug' && !debug) return;

    const output = JSON.stringify({ ...redactLogValue(context), message: redactLogValue(message) });
    const method = level === 'warn' || level === 'error' ? 'error' : 'log';
    consoleTarget[method](output);
  };

  return Object.fromEntries(LEVELS.map((level) => [level, (context, message) => write(level, context, message)]));
}

export function resolveLogger(candidate, { debug = false } = {}) {
  const target = candidate ?? createDefaultLogger({ debug });
  validateLogger(target);

  const wrap = (bindings = {}) => {
    const facade = {};
    for (const level of LEVELS) {
      facade[level] = (context = {}, message = '') => {
        target[level].call(target, redactLogValue({ ...bindings, ...context }), redactLogValue(message));
      };
    }
    facade.child = (extra = {}) => {
      const safeBindings = redactLogValue(extra);
      return typeof target.child === 'function'
        ? resolveLogger(target.child.call(target, safeBindings), { debug })
        : wrap({ ...bindings, ...safeBindings });
    };
    return facade;
  };

  return wrap();
}
