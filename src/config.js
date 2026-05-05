import 'dotenv/config';

export default Object.freeze({
  API_KEY: process.env.OPENROUTER_API_KEY,
  ORDERS: process.env.OPENROUTER_ORDER?.split?.(','),
  ONLY: process.env.OPENROUTER_ONLY?.split?.(','),
  MODEL: process.env.OPENROUTER_MODEL,
  MAX_TOKENS: process.env.OPENROUTER_MAX_TOKENS,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  MAX_RETRIES: 5,
  DEBUG: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
});
