import * as cheerio from 'cheerio';
import { CONSTANTS } from '../../core/utils.js';

// Private/reserved IP ranges to block for SSRF prevention
const BLOCKED_IP_RANGES = [
  /^127\./,          // IPv4 loopback
  /^10\./,           // RFC 1918 - Class A private
  /^172\.(1[6-9]|2\d|3[01])\./,  // RFC 1918 - Class B private
  /^192\.168\./,     // RFC 1918 - Class C private
  /^0\./,            // Invalid
  /^169\.254\./,     // Link-local
  /^::1$/,           // IPv6 loopback
  /^fc00:/,          // IPv6 unique local
  /^fe80:/,          // IPv6 link-local
  /^fd00:/,          // IPv6 unique local
];

/**
 * Check if a URL targets an internal/private resource (SSRF prevention).
 * Blocks private IPs, localhost, and non-HTTP(S) protocols.
 */
function checkSSRF(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;

    // Block by hostname
    if (hostname === 'localhost' || hostname === 'localhost.localdomain' ||
        hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
        hostname === '[::1]' || hostname === '::1') {
      throw new Error('Access denied: localhost/internal host is not allowed');
    }

    // Block private/reserved IP ranges
    const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    if (isIPv4) {
      for (const range of BLOCKED_IP_RANGES) {
        if (range.test(hostname)) {
          throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
        }
      }
    }

    // Block non-http(s) protocols (file://, ftp://, etc.)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Access denied: protocol '${url.protocol}' is not allowed. Only http:// and https:// are supported.`);
    }
  } catch (err) {
    if (err.message.startsWith('Access denied')) throw err;
    throw new Error(`Invalid URL: ${err.message}`);
  }
}

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
    // Validate URL format (throws if invalid)
    new URL(url);

    // SSRF protection: block internal/private resources
    checkSSRF(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

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
    $('script, style, nav, footer, header, noscript, aside, iframe, form, svg, canvas, [aria-hidden="true"], [hidden], .hidden').remove();

    let cleanText = $('article, main, body').text();
    if (!cleanText || cleanText.trim().length < 100) {
      cleanText = $.text();
    }

    // Preserve paragraph structure: collapse horizontal whitespace but keep newlines
    cleanText = cleanText.replace(/[ \t\xa0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    return cleanText.length > limit ? cleanText.slice(0, limit) + '\n[... truncated]' : cleanText;
  } catch (error) {
    throw error;
  }
};