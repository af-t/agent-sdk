import config from '../../config.js';
import { CONSTANTS } from '../../core/utils.js';

export const name = 'WebSearch';
export const description = 'Search the web using Tavily. Use this to find current information, research topics, get documentation links, or answer questions that require up-to-date web data. Returns relevant results with snippets and source URLs. Supports deep search mode for comprehensive research.';
export const input_schema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query — be specific for best results' },
    depth: { type: 'string', enum: ['basic', 'advanced'], description: '"basic" for quick results (default), "advanced" for deeper research with longer context' },
    maxResults: { type: 'number', description: 'Number of results to return (default: 5, max: 20)' },
    includeAnswer: { type: 'boolean', description: 'Include an AI-generated answer synthesizing results (default: false)' },
    includeDomains: { type: 'array', items: { type: 'string' }, description: 'Only search within these domains (e.g. ["python.org", "stackoverflow.com"])' },
    excludeDomains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains from results' }
  },
  required: ['query']
};

export const execute = async ({ query, depth = 'basic', maxResults = 5, includeAnswer = false, includeDomains, excludeDomains }) => {
  const apiKey = config.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured. Set it in .env or environment variables.');
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

    const body = {
      api_key: apiKey,
      query,
      search_depth: depth,
      max_results: Math.min(maxResults, 20),
      include_answer: includeAnswer,
    };
    if (includeDomains?.length) body.include_domains = includeDomains;
    if (excludeDomains?.length) body.exclude_domains = excludeDomains;

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => 'Unknown error');
      throw new Error(`Tavily search failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    let output = '';

    if (data.answer) {
      output += `## AI Answer\n${data.answer}\n\n`;
    }

    if (data.results?.length > 0) {
      output += `## Search Results for: "${query}"\n\n`;
      data.results.forEach((r, i) => {
        output += `${i + 1}. ${r.title || 'Untitled'}\n`;
        output += `   URL: ${r.url}\n`;
        output += `   ${r.content?.slice(0, 500) || 'No content available'}\n`;
        if (r.score !== undefined) output += `   Relevance: ${(r.score * 100).toFixed(0)}%\n`;
        output += '\n';
      });
    } else {
      output += 'No results found.';
    }

    if (data.response_time) {
      output += `\n_(Response time: ${data.response_time}s)_`;
    }

    return output.trim();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Search request timed out after 15 seconds. Try a more specific query.');
    }
    throw error;
  }
};
