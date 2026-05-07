import * as cheerio from 'cheerio';
import { CONSTANTS } from '../../core/utils.js';
import dns from 'node:dns/promises';

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

// Binary if non-printable chars > 70%
function isBinaryContent(text) {
  const nonPrintable = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
  return nonPrintable / text.length > 0.7;
}

// Prepend Content-Type annotation
function withContentType(contentType, body) {
  const label = `Content-Type: ${contentType}`;
  return `${label}\n\n${body}`;
}

// Check if IP is in blocked range
function isBlockedIp(ip) {
  return BLOCKED_IP_RANGES.some(range => range.test(ip));
}

// SSRF check — blocks private IPs, localhost, DNS rebinding, non-HTTP(S)
async function checkSSRF(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;

    // Block by hostname
    if (hostname === 'localhost' || hostname === 'localhost.localdomain' ||
        hostname === '127.0.0.1' || hostname === '0.0.0.0' ||
        hostname === '[::1]' || hostname === '::1') {
      throw new Error('Access denied: localhost/internal host is not allowed');
    }

    // Block non-http(s) protocols (file://, ftp://, etc.)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Access denied: protocol '${url.protocol}' is not allowed. Only http:// and https:// are supported.`);
    }

    // Check if hostname is a literal IPv4 address
    const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    if (isIPv4) {
      if (isBlockedIp(hostname)) {
        throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
      }
      // Hostname is a public IPv4 — no DNS resolution needed
      return;
    }

    // Check if hostname is a literal IPv6 address
    const isIPv6 = /^\[?[0-9a-fA-F:]+(?:\.[0-9.]+)?\]?$/.test(hostname);
    if (isIPv6) {
      const normalized = hostname.replace(/^\[|\]$/g, '');
      if (isBlockedIp(normalized)) {
        throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
      }
      return;
    }

    // DNS rebinding defense: resolve the hostname and check resolved IPs
    // Handle DNS resolution errors gracefully — if DNS fails completely,
    // we cannot determine safety; reject to be safe
    let resolvedSomething = false;
    try {
      const addresses = await dns.resolve4(hostname);
      resolvedSomething = true;
      for (const ip of addresses) {
        if (isBlockedIp(ip)) {
          throw new Error('Access denied: hostname resolves to private/reserved IP range (SSRF protection)');
        }
      }
    } catch (err) {
      if (err.message.startsWith('Access denied')) throw err;
      // ENOTFOUND for IPv4 is acceptable — try IPv6 next
    }

    try {
      const addressesv6 = await dns.resolve6(hostname);
      resolvedSomething = true;
      for (const ip of addressesv6) {
        if (isBlockedIp(ip)) {
          throw new Error('Access denied: hostname resolves to private/reserved IP range (SSRF protection)');
        }
      }
    } catch (err) {
      if (err.message.startsWith('Access denied')) throw err;
      // ENOTFOUND for IPv6 is also acceptable
    }

    if (!resolvedSomething) {
      // If we couldn't resolve the hostname at all, it's safer to block
      // unless it was already a literal IP (handled above).
      throw new Error(`Access denied: unable to resolve hostname '${hostname}'`);
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
    await checkSSRF(url);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

    // Redirect hardening: manual mode to re-check each step
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual'
    });
    clearTimeout(timeout);

    // Handle manual redirects to prevent SSRF bypass via redirects
    if (res.status >= 300 && res.status < 400) {
      const redirectUrl = res.headers.get('location');
      if (redirectUrl) {
        // Recursive check of the redirect URL
        await checkSSRF(redirectUrl);
        // Recursively call execute for the redirect URL
        return execute({ url: redirectUrl, useRaw, limit });
      }
    }

    // Reject oversized responses
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > CONSTANTS.FETCH_MAX_SIZE) {
      throw new Error(`Response too large (${contentLength} bytes). Maximum allowed is ${CONSTANTS.FETCH_MAX_SIZE} bytes (10MB).`);
    }

    const contentType = res.headers.get('content-type') || 'unknown';
    const raw = await res.text();

    // Reject binary content (non-printable chars > 70%)
    if (isBinaryContent(raw)) {
      throw new Error(`Binary content detected (content-type: ${contentType}). WebFetch cannot process binary files.`);
    }

    if (contentType.includes('application/json')) {
      return withContentType(contentType, raw.length > limit ? raw.slice(0, limit) + '\n[... truncated]' : raw);
    }

    if (contentType.includes('text/plain') || contentType.includes('text/csv') || contentType.includes('text/markdown')) {
      return withContentType(contentType, raw.length > limit ? raw.slice(0, limit) + '\n[... truncated]' : raw);
    }

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      // Unknown type — return as plain text
      return withContentType(contentType, raw.length > limit ? raw.slice(0, limit) + '\n[... truncated]' : raw);
    }

    // Only HTML reaches cheerio
    if (useRaw) {
      return withContentType(contentType, raw.length > limit ? raw.slice(0, limit) + '\n[... truncated]' : raw);
    }

    // Smart Scraper
    const $ = cheerio.load(raw);
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

export { checkSSRF, isBlockedIp };
