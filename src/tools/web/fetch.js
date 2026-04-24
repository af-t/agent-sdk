import * as cheerio from 'cheerio';

export const name = 'WebFetch';
export const description = 'Fetch and analyze content from a URL. Use this to retrieve documentation, research technical topics, or read raw code from the web. It automatically cleans HTML for readability.';
export const input_schema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Target URL' },
    useRaw: { type: 'boolean', description: 'Return raw HTML if true' },
    limit: { type: 'number', description: 'Max characters to return (default 20000)' }
  },
  required: ['url']
};

export const execute = async ({ url, useRaw = false, limit = 20000 }) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    const contentType = res.headers.get('content-type');

    if (contentType && contentType.includes('application/json')) {
      const json = await res.text();
      return json.length > limit ? json.slice(0, limit) + '\n[... truncated]' : json;
    }

    const html = await res.text();
    if (useRaw) {
      return html.length > limit ? html.slice(0, limit) + '\n[... truncated]' : html;
    }

    // Smart Scraper
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript').remove();

    let cleanText = $('article, main, body').text();
    if (!cleanText || cleanText.trim().length < 100) {
      cleanText = $.text();
    }

    // Normalize whitespace
    cleanText = cleanText.replace(/\s\s+/g, ' ').trim();

    return cleanText.length > limit ? cleanText.slice(0, limit) + '\n[... truncated]' : cleanText;
  } catch (error) {
    return `ERROR: Fetch failed: ${error.message}`;
  }
};
