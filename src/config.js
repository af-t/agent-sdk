import process from 'node:process';

try {
  process.loadEnvFile();
} catch {
  // Ignore if .env doesn't exist
}

function deepFreeze(obj) {
  if (Object.isFrozen(obj)) return obj;
  const keys = Object.getOwnPropertyNames(obj);
  for (const key of keys) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return Object.freeze(obj);
}

export default deepFreeze({
  API_KEY: process.env.OPENROUTER_API_KEY,
  ORDER: process.env.OPENROUTER_ORDER?.split?.(','),
  ONLY: process.env.OPENROUTER_ONLY?.split?.(','),
  MODEL: process.env.OPENROUTER_MODEL,
  MAX_TOKENS: process.env.OPENROUTER_MAX_TOKENS,
  MAX_TURNS: process.env.OPENROUTER_MAX_TURNS,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  MAX_RETRIES: 5,
  DEBUG: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
});
