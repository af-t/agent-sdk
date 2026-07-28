export function resolveApiDialect(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai') ? 'openrouter' : 'openai';
  } catch {
    return String(baseUrl).toLowerCase().includes('openrouter.ai') ? 'openrouter' : 'openai';
  }
}

export function buildRequestHeaders({ apiKey, dialect }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (dialect === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/af-t/agent-sdk';
    headers['X-Title'] = 'OpenRouter CLI Agent';
    headers['X-OpenRouter-Title'] = 'OpenRouter CLI Agent';
  }
  return headers;
}
