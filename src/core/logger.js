import config from '../config.js';

const PREFIXES = {
  error: '\x1b[1;31m* [ERROR]\x1b[0m',
  warn: '\x1b[0;33m* [WARN] \x1b[0m',
  info: '\x1b[0;36m* [INFO] \x1b[0m',
  debug: '\x1b[2m* [DEBUG]\x1b[0m',
};

// Known API key / secret patterns to redact from logs
// Order matters: more specific patterns first to avoid partial matches
const SECRET_PATTERNS = [
  // Authorization headers (must come before Bearer to capture full header)
  /(Authorization:\s*Bearer\s+)[a-zA-Z0-9._-]+/g,
  // Bearer tokens (must come before API keys to prevent double-redaction)
  /(Bearer\s+)[a-zA-Z0-9._-]+/g,
  // OpenRouter: sk-or-... / sk-ant-...  (capture prefix only, redact the token)
  /(sk-(?:or|ant)-)[a-zA-Z0-9_-]+/g,
  // Tavily: tvly-...  (capture prefix only, redact the token)
  /(tvly-)[a-zA-Z0-9_-]+/g,
  // API keys in URLs (e.g., ?key=... or &api_key=...)
  /([?&](?:api_key|key|token|apikey)=)[^&\s]+/gi,
  // Generic "KEY=value" patterns in env dumps
  /((?:API_KEY|SECRET|TOKEN|PASSWORD)[^=]*=\s*['"]?)[^'"\s]+/gi,
];

// Redact known secret patterns; non-strings pass through
function redact(msg) {
  if (typeof msg !== 'string') return msg;
  let s = msg;
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (match, prefix) => `${prefix || ''}***REDACTED***`);
  }
  return s;
}

export const logger = {
  error: (msg, ...args) => {
    console.error(`${PREFIXES.error} ${redact(msg)}`, ...args.map(redact));
  },
  warn: (msg, ...args) => {
    console.warn(`${PREFIXES.warn} ${redact(msg)}`, ...args.map(redact));
  },
  debug: (msg, ...args) => {
    if (config.DEBUG) {
      console.log(`${PREFIXES.debug} ${redact(msg)}`, ...args.map(redact));
    }
  },
  info: (msg, ...args) => {
    console.log(`${PREFIXES.info} ${redact(msg)}`, ...args.map(redact));
  },
};

export default logger;
