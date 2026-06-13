import * as cheerio from 'cheerio';
import { CONSTANTS, truncateOutput } from '../../core/utils.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

// Private/reserved IP ranges to block for SSRF prevention
const BLOCKED_IP_RANGES = [
  /^127\./, // IPv4 loopback
  /^10\./, // RFC 1918 - Class A private
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC 1918 - Class B private
  /^192\.168\./, // RFC 1918 - Class C private
  /^0\./, // Invalid
  /^169\.254\./, // Link-local
  /^::1$/, // IPv6 loopback
  /^::$/, // IPv6 unspecified
  /^fc00:/, // IPv6 unique local
  /^fe80:/, // IPv6 link-local
  /^fd00:/, // IPv6 unique local
];

// Max redirects before giving up
const MAX_REDIRECTS = 5;

// Unwrap IPv4-mapped IPv6 addresses
function unmapIPv4(ip) {
  const m = ip
    .toLowerCase()
    .replace(/^0:0:0:0:0:ffff:/, '::ffff:')
    .match(/^::ffff:(.+)$/);
  if (!m) return ip;
  const tail = m[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return ip;
}

// Binary if non-printable chars > 70%
function isBinaryContent(text) {
  // eslint-disable-next-line no-control-regex -- intentionally matches control chars for binary detection
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
  const target = unmapIPv4(ip);
  return BLOCKED_IP_RANGES.some((range) => range.test(target));
}

// Read body with a hard byte cap
async function readBodyCapped(res, maxBytes) {
  // Fallback for stubs/responses without a web stream body
  if (!res.body || typeof res.body.getReader !== 'function') {
    return res.text();
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response too large (over ${maxBytes} bytes). Maximum allowed is ${maxBytes} bytes (10MB).`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// SSRF check — blocks private IPs, localhost, DNS rebinding, non-HTTP(S).
// Returns the validated addresses to pin (or null for a literal-IP host).
async function checkSSRF(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;

    // Block by hostname
    if (
      hostname === 'localhost' ||
      hostname === 'localhost.localdomain' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '[::1]' ||
      hostname === '::1'
    ) {
      throw new Error('Access denied: localhost/internal host is not allowed');
    }

    // Block non-http(s) protocols (file://, ftp://, etc.)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `Access denied: protocol '${url.protocol}' is not allowed. Only http:// and https:// are supported.`,
      );
    }

    // Check if hostname is a literal IPv4 address
    const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    if (isIPv4) {
      if (isBlockedIp(hostname)) {
        throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
      }
      // Literal IP — the socket connects straight to it, no lookup to pin
      return null;
    }

    // Check if hostname is a literal IPv6 address
    const isIPv6 = /^\[?[0-9a-fA-F:]+(?:\.[0-9.]+)?\]?$/.test(hostname);
    if (isIPv6) {
      const normalized = hostname.replace(/^\[|\]$/g, '');
      if (isBlockedIp(normalized)) {
        throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
      }
      return null;
    }

    // DNS rebinding defense: resolve the hostname, check every IP, and keep the
    // validated set so the actual connection pins to it (no second resolution).
    const addresses = [];
    try {
      for (const ip of await dns.resolve4(hostname)) {
        if (isBlockedIp(ip)) {
          throw new Error('Access denied: hostname resolves to private/reserved IP range (SSRF protection)');
        }
        addresses.push({ address: ip, family: 4 });
      }
    } catch (err) {
      if (err.message.startsWith('Access denied')) throw err;
      // ENOTFOUND for IPv4 is acceptable — try IPv6 next
    }

    try {
      for (const ip of await dns.resolve6(hostname)) {
        if (isBlockedIp(ip)) {
          throw new Error('Access denied: hostname resolves to private/reserved IP range (SSRF protection)');
        }
        addresses.push({ address: ip, family: 6 });
      }
    } catch (err) {
      if (err.message.startsWith('Access denied')) throw err;
      // ENOTFOUND for IPv6 is also acceptable
    }

    if (addresses.length === 0) {
      // If we couldn't resolve the hostname at all, it's safer to block
      // unless it was already a literal IP (handled above).
      throw new Error(`Access denied: unable to resolve hostname '${hostname}'`);
    }
    return addresses;
  } catch (err) {
    if (err.message.startsWith('Access denied')) throw err;
    throw new Error(`Invalid URL: ${err.message}`, { cause: err });
  }
}

// Pinning lookup: hands the socket only the IPs checkSSRF already validated,
// re-checking each one so a rebind cannot slip a private IP into the connection.
function makeLookup(addresses) {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const wantAll = typeof options === 'object' && options !== null && options.all;
    const safe = addresses.filter((a) => !isBlockedIp(a.address));
    if (safe.length === 0) {
      cb(new Error('Access denied: hostname resolves to private/reserved IP range (SSRF protection)'));
      return;
    }
    if (wantAll) cb(null, safe.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, safe[0].address, safe[0].family);
  };
}

// Minimal fetch-shaped transport over node:http(s) so we can pin DNS via lookup
function requestOnce(urlStr, { signal, lookup } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', signal, lookup }, (res) => {
      resolve({
        status: res.statusCode,
        headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
        body: Readable.toWeb(res),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let _transport = requestOnce;
// Swap the transport (tests inject a stub); no argument restores the default
export function _setTransport(fn) {
  _transport = fn || requestOnce;
}

export const name = 'WebFetch';
export const description =
  'Fetch and analyze content from a URL. Use this to retrieve documentation, research technical topics, or read raw code from the web. It automatically cleans HTML for readability.';
export const input_schema = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Target URL' },
    use_raw: { type: 'boolean', description: 'Return raw HTML if true' },
    limit: { type: 'number', description: 'Max characters to return (default 20000)' },
  },
  required: ['url'],
};

export const execute = async ({ url, use_raw, useRaw = false, limit = 20000 }, ctx = {}) => {
  const finalUseRaw = use_raw !== undefined ? use_raw : useRaw;

  // Validate URL format (throws if invalid)
  new URL(url);

  // SSRF protection: block internal/private resources; pin the validated IPs
  const pinnedAddresses = await checkSSRF(url);

  if (ctx.signal?.aborted) throw new Error('Request aborted');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONSTANTS.FETCH_TIMEOUT_MS);

  const onAbort = () => controller.abort();
  if (ctx.signal) {
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  let raw;
  let contentType;
  try {
    // node:http(s) never auto-follows redirects, so each hop is re-checked below
    res = await _transport(url, {
      signal: controller.signal,
      lookup: pinnedAddresses ? makeLookup(pinnedAddresses) : undefined,
    });

    // Handle manual redirects to prevent SSRF bypass via redirects
    if (res.status >= 300 && res.status < 400) {
      let redirectUrl = res.headers.get('location');
      if (redirectUrl) {
        const redirectDepth = (ctx._redirectDepth || 0) + 1;
        if (redirectDepth > MAX_REDIRECTS) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }

        // Strip credentials from redirect URL to prevent leaking
        const parsed = new URL(redirectUrl, url);
        parsed.username = '';
        parsed.password = '';
        redirectUrl = parsed.toString();

        // SSRF check on the sanitised redirect URL
        await checkSSRF(redirectUrl);
        // Release the redirect response body before recursing
        await res.body?.cancel().catch(() => {});
        // Recursively call execute for the redirect URL
        return execute({ url: redirectUrl, use_raw: finalUseRaw, limit }, { ...ctx, _redirectDepth: redirectDepth });
      }
    }

    // Reject oversized responses
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > CONSTANTS.FETCH_MAX_SIZE) {
      throw new Error(
        `Response too large (${contentLength} bytes). Maximum allowed is ${CONSTANTS.FETCH_MAX_SIZE} bytes (10MB).`,
      );
    }

    contentType = res.headers.get('content-type') || 'unknown';
    // Hard cap even without content-length (chunked responses)
    raw = await readBodyCapped(res, CONSTANTS.FETCH_MAX_SIZE);
  } finally {
    clearTimeout(timeout);
    if (ctx.signal) {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  // Reject binary content (non-printable chars > 70%)
  if (isBinaryContent(raw)) {
    throw new Error(`Binary content detected (content-type: ${contentType}). WebFetch cannot process binary files.`);
  }

  if (contentType.includes('application/json')) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  if (contentType.includes('text/plain') || contentType.includes('text/csv') || contentType.includes('text/markdown')) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    // Unknown type — return as plain text
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  // Only HTML reaches cheerio
  if (finalUseRaw) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  // Smart Scraper
  const $ = cheerio.load(raw);
  $(
    'script, style, nav, footer, header, noscript, aside, iframe, form, svg, canvas, [aria-hidden="true"], [hidden], .hidden',
  ).remove();

  let cleanText = $('article, main, body').text();
  if (!cleanText || cleanText.trim().length < 100) {
    cleanText = $.text();
  }

  // Preserve paragraph structure: collapse horizontal whitespace but keep newlines
  cleanText = cleanText
    .replace(/[ \t\xa0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return truncateOutput(cleanText, limit);
};

export { checkSSRF, isBlockedIp };
