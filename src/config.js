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
  AUTO_WAKE: process.env.OPENROUTER_AUTO_WAKE,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  MAX_RETRIES: 5,
  DEBUG: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
  TEMPERATURE: process.env.OPENROUTER_TEMPERATURE,
  TOP_P: process.env.OPENROUTER_TOP_P,
  MIN_P: process.env.OPENROUTER_MIN_P,
  TOP_K: process.env.OPENROUTER_TOP_K,
  FREQUENCY_PENALTY: process.env.OPENROUTER_FREQUENCY_PENALTY,
  PRESENCE_PENALTY: process.env.OPENROUTER_PRESENCE_PENALTY,
  REPETITION_PENALTY: process.env.OPENROUTER_REPETITION_PENALTY,
  SEED: process.env.OPENROUTER_SEED,
  MAX_COMPLETION_TOKENS: process.env.OPENROUTER_MAX_COMPLETION_TOKENS,
  REASONING_EFFORT: process.env.OPENROUTER_REASONING_EFFORT,
  REASONING_MAX_TOKENS: process.env.OPENROUTER_REASONING_MAX_TOKENS,
  REASONING_EXCLUDE: process.env.OPENROUTER_REASONING_EXCLUDE === 'true' || process.env.OPENROUTER_REASONING_EXCLUDE === '1' ? true : process.env.OPENROUTER_REASONING_EXCLUDE === 'false' || process.env.OPENROUTER_REASONING_EXCLUDE === '0' ? false : undefined,
  REASONING_ENABLED: process.env.OPENROUTER_REASONING_ENABLED === 'true' || process.env.OPENROUTER_REASONING_ENABLED === '1' ? true : process.env.OPENROUTER_REASONING_ENABLED === 'false' || process.env.OPENROUTER_REASONING_ENABLED === '0' ? false : undefined,
  PROVIDER_ALLOW_FALLBACKS: process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS === 'true' || process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS === '1' ? true : process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS === 'false' || process.env.OPENROUTER_PROVIDER_ALLOW_FALLBACKS === '0' ? false : undefined,
  PROVIDER_REQUIRE_PARAMETERS: process.env.OPENROUTER_PROVIDER_REQUIRE_PARAMETERS === 'true' || process.env.OPENROUTER_PROVIDER_REQUIRE_PARAMETERS === '1' ? true : process.env.OPENROUTER_PROVIDER_REQUIRE_PARAMETERS === 'false' || process.env.OPENROUTER_PROVIDER_REQUIRE_PARAMETERS === '0' ? false : undefined,
  PROVIDER_DATA_COLLECTION: process.env.OPENROUTER_PROVIDER_DATA_COLLECTION,
  PROVIDER_AVOID: process.env.OPENROUTER_PROVIDER_AVOID?.split?.(','),
  PROVIDER_SORT: process.env.OPENROUTER_PROVIDER_SORT,
});
