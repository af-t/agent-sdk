import { ConfigError } from '../support/errors.js';

function readBoolean(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function readNumber(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  const normalized = value.trim();
  if (normalized === '') {
    throw new ConfigError(`${name} must be a finite number`);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) {
    throw new ConfigError(`${name} must be a finite number`);
  }
  return number;
}

function readList(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return undefined;
  return value.split(',').map((item) => item.trim());
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function loadEnvironmentConfig(env = process.env) {
  return deepFreeze({
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
    appName: env.AGENT_SDK_APP_NAME,
    embeddingModel: env.OPENROUTER_EMBEDDING_MODEL,
    maxTurns: readNumber(env, 'OPENROUTER_MAX_TURNS'),
    autoWake: readBoolean(env, 'OPENROUTER_AUTO_WAKE'),
    emptyTurnRecovery: readBoolean(env, 'OPENROUTER_EMPTY_TURN_RECOVERY'),
    emptyTurnRetries: readNumber(env, 'OPENROUTER_EMPTY_TURN_RETRIES'),
    tavilyApiKey: env.TAVILY_API_KEY,
    maxRetries: 5,
    debug: readBoolean(env, 'DEBUG') ?? false,
    temperature: readNumber(env, 'OPENROUTER_TEMPERATURE'),
    topP: readNumber(env, 'OPENROUTER_TOP_P'),
    minP: readNumber(env, 'OPENROUTER_MIN_P'),
    topK: readNumber(env, 'OPENROUTER_TOP_K'),
    frequencyPenalty: readNumber(env, 'OPENROUTER_FREQUENCY_PENALTY'),
    presencePenalty: readNumber(env, 'OPENROUTER_PRESENCE_PENALTY'),
    repetitionPenalty: readNumber(env, 'OPENROUTER_REPETITION_PENALTY'),
    seed: readNumber(env, 'OPENROUTER_SEED'),
    maxCompletionTokens: readNumber(env, 'OPENROUTER_MAX_COMPLETION_TOKENS'),
    reasoning: {
      effort: env.OPENROUTER_REASONING_EFFORT,
      maxTokens: readNumber(env, 'OPENROUTER_REASONING_MAX_TOKENS'),
      exclude: readBoolean(env, 'OPENROUTER_REASONING_EXCLUDE'),
      enabled: readBoolean(env, 'OPENROUTER_REASONING_ENABLED'),
    },
    provider: {
      order: readList(env, 'OPENROUTER_ORDER'),
      only: readList(env, 'OPENROUTER_ONLY'),
      allowFallbacks: readBoolean(env, 'OPENROUTER_PROVIDER_ALLOW_FALLBACKS'),
      requireParameters: readBoolean(env, 'OPENROUTER_PROVIDER_REQUIRE_PARAMETERS'),
      dataCollection: env.OPENROUTER_PROVIDER_DATA_COLLECTION,
      avoid: readList(env, 'OPENROUTER_PROVIDER_IGNORE') ?? readList(env, 'OPENROUTER_PROVIDER_AVOID'),
      sort: env.OPENROUTER_PROVIDER_SORT,
    },
  });
}
