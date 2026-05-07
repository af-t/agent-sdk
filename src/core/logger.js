import config from '../config.js';

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[0;31m',
  yellow: '\x1b[0;33m',
  dim: '\x1b[2m',
};

const prefix = (color) => `${color}*${colors.reset}`;

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
    console.error(`${prefix(colors.red)} ${redact(msg)}`, ...args.map(redact));
  },
  warn: (msg, ...args) => {
    console.warn(`${prefix(colors.yellow)} [WARN] ${redact(msg)}`, ...args.map(redact));
  },
  debug: (msg, ...args) => {
    if (config.DEBUG) {
      console.log(`${prefix(colors.dim)} [DEBUG] ${redact(msg)}`, ...args.map(redact));
    }
  },
  info: (msg, ...args) => {
    console.log(`${prefix(colors.dim)} [INFO] ${redact(msg)}`, ...args.map(redact));
  }
};

export default logger;