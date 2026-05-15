import { CONSTANTS, truncateOutput } from '../../core/utils.js';

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, '').trim();
}

export const name = 'WebSearch';
export const parallelSafe = true;
export const description =
  'Search the web. Uses Tavily when TAVILY_API_KEY is configured, otherwise falls back to DuckDuckGo. Use to find current information, research topics, or answer questions that require up-to-date web data. Returns results with snippets and source URLs.';
export const input_schema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Search query — be specific for best results' },
    depth: {
      type: 'string',
      enum: ['basic', 'advanced'],
      description: '"basic" for quick results (default), "advanced" for deeper research with longer context',
    },
    maxResults: { type: 'number', description: 'Number of results to return (default: 5, max: 20)' },
    includeAnswer: {
      type: 'boolean',
      description: 'Include an AI-generated answer synthesizing results (default: false)',
    },
    includeDomains: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only search within these domains (e.g. ["python.org", "stackoverflow.com"])',
    },
    excludeDomains: { type: 'array', items: { type: 'string' }, description: 'Exclude these domains from results' },
  },
  required: ['query'],
};

export async function ddgJsonSearch(query, maxResults, signal) {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const timer = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { signal: controller.signal },
    );

    if (!res.ok) throw new Error(`DuckDuckGo search failed (${res.status})`);

    const data = await res.json();
    const results = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({ title: data.Heading || query, url: data.AbstractURL, snippet: data.AbstractText });
    }

    for (const topic of data.RelatedTopics || []) {
      if (results.length >= maxResults) break;
      if (topic.Topics) continue;
      if (topic.FirstURL && topic.Text) {
        results.push({ title: topic.Text.split(' - ')[0].trim(), url: topic.FirstURL, snippet: topic.Text });
      }
    }

    return results.slice(0, maxResults);
  } finally {
    clearTimeout(timer);
  }
}

export async function ddgHtmlSearch(query, maxResults, signal) {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const timer = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`DuckDuckGo search failed (${res.status})`);

    const html = await res.text();
    const results = [];
    const blocks = html.split(/<div\b[^>]*\bclass="result\b/);
    const linkRe = /href="[^"]*uddg=([^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/;
    const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

    for (let i = 1; i < blocks.length && results.length < maxResults; i++) {
      const block = blocks[i];
      const linkMatch = linkRe.exec(block);
      if (!linkMatch) continue;
      let url;
      try {
        url = decodeURIComponent(linkMatch[1]);
      } catch {
        continue;
      }
      const snippetMatch = snippetRe.exec(block);
      results.push({
        url,
        title: decodeHtmlEntities(stripTags(linkMatch[2])),
        snippet: snippetMatch ? decodeHtmlEntities(stripTags(snippetMatch[1])) : '',
      });
    }

    return results;
  } finally {
    clearTimeout(timer);
  }
}

export async function ddgSearch(query, maxResults, signal) {
  try {
    const results = await ddgJsonSearch(query, maxResults, signal);
    if (results.length > 0) return results;
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }
  return ddgHtmlSearch(query, maxResults, signal);
}

export function formatDdgResults(query, results) {
  if (results.length === 0) return 'No results found.';
  let output = `## Search Results for: "${query}" [via DuckDuckGo]\n\n`;
  results.forEach((r, i) => {
    output += `${i + 1}. ${r.title}\n`;
    output += `   URL: ${r.url}\n`;
    if (r.snippet) output += `   ${truncateOutput(r.snippet, 500)}\n`;
    output += '\n';
  });
  return output.trim();
}

export const execute = async (
  { query, depth = 'basic', maxResults = 5, includeAnswer = false, includeDomains, excludeDomains },
  ctx = {},
) => {
  if (ctx.signal?.aborted) throw new Error('Request aborted');

  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    const capped = Math.min(maxResults, 20);
    try {
      const results = await ddgSearch(query, capped, ctx.signal);
      return formatDdgResults(query, results);
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Search request timed out after 15 seconds. Try a more specific query.');
      }
      throw error;
    }
  }

  const controller = new AbortController();
  if (ctx.signal) {
    ctx.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

  try {
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
      signal: controller.signal,
    });

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
        output += `   ${truncateOutput(r.content || 'No content available', 500)}\n`;
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
  } finally {
    clearTimeout(timeout);
  }
};
