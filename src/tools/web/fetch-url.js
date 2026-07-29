import * as cheerio from 'cheerio';
import { LIMITS, truncateOutput } from '../../support/payload.js';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

// SSRF protection blocks private and reserved IP ranges.
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

// A redirect limit prevents unbounded chains.
const MAX_REDIRECTS = 5;

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

// Text with more than 70 percent non-printable characters is treated as binary.
function isBinaryContent(text) {
  // eslint-disable-next-line no-control-regex -- intentionally matches control chars for binary detection
  const nonPrintable = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
  return nonPrintable / text.length > 0.7;
}

function withContentType(contentType, body) {
  const label = `Content-Type: ${contentType}`;
  return `${label}\n\n${body}`;
}

export function isBlockedIp(ip) {
  const target = unmapIPv4(ip);
  return BLOCKED_IP_RANGES.some((range) => range.test(target));
}

async function readBodyCapped(res, maxBytes) {
  // Test transports and some fetch implementations expose no web stream body.
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

// checkSSRF blocks private IPs, localhost, DNS rebinding, and non-HTTP protocols.
// It returns validated addresses to pin, or null for a literal-IP host.
export async function checkSSRF(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname;

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

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `Access denied: protocol '${url.protocol}' is not allowed. Only http:// and https:// are supported.`,
      );
    }

    // A literal IPv4 address can be checked without DNS.
    const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    if (isIPv4) {
      if (isBlockedIp(hostname)) {
        throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
      }
      // A literal IP connects directly, so there is no DNS result to pin.
      return null;
    }

    // A literal IPv6 address can be checked without DNS.
    const isIPv6 = /^\[?[0-9a-fA-F:]+(?:\.[0-9.]+)?\]?$/.test(hostname);
    if (isIPv6) {
      const normalized = hostname.replace(/^\[|\]$/g, '');
      if (isBlockedIp(normalized)) {
        throw new Error('Access denied: private/reserved IP range is not allowed (SSRF protection)');
      }
      return null;
    }

    // Resolving every address once and pinning that set prevents DNS rebinding
    // between validation and connection.
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
      // An IPv4 miss still permits an IPv6 lookup.
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
      // An IPv6 miss is acceptable when IPv4 has already resolved.
    }

    if (addresses.length === 0) {
      // A hostname that resolves to no address cannot be connected safely.
      throw new Error(`Access denied: unable to resolve hostname '${hostname}'`);
    }
    return addresses;
  } catch (err) {
    if (err.message.startsWith('Access denied')) throw err;
    throw new Error(`Invalid URL: ${err.message}`, { cause: err });
  }
}

// The pinning lookup gives the socket only addresses that checkSSRF validated.
// It checks them again before connection.
function makeLookup(addresses) {
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const wantAll = typeof options === 'object' && options !== null && options.all;
    const safe = addresses.filter((a) => !isBlockedIp(a.address));
    if (safe.length === 0) {
      cb(new Error('Access denied: hostname resolves to private/reserved IP range (SSRF protection)'));
      return;
    }
    if (wantAll)
      cb(
        null,
        safe.map((a) => ({ address: a.address, family: a.family })),
      );
    else cb(null, safe[0].address, safe[0].family);
  };
}

// requestOnce provides a fetch-shaped transport whose lookup can pin DNS.
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

const description = 'Fetch an HTTP or HTTPS URL. By default, HTML is reduced to readable text.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: 'URL to fetch.' },
    rawContent: { type: 'boolean', description: 'Return the response without reducing HTML.' },
    limit: { type: 'number', description: 'Maximum characters to return. The default is 20000.' },
  },
  required: ['url'],
};

const execute = async ({ url, rawContent = false, limit = 20000 }, ctx = {}) => {
  // Redirects reuse a caller-supplied fetch-shaped transport.
  const transport = ctx.transport ?? requestOnce;

  new URL(url);

  // Pinning the validated IPs closes the gap between validation and connection.
  const pinnedAddresses = await checkSSRF(url);

  if (ctx.signal?.aborted) throw new Error('Request aborted');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIMITS.fetchTimeoutMs);

  const onAbort = () => controller.abort();
  if (ctx.signal) {
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  let raw;
  let contentType;
  try {
    // node:http(s) does not follow redirects, so each hop is checked here.
    res = await transport(url, {
      signal: controller.signal,
      lookup: pinnedAddresses ? makeLookup(pinnedAddresses) : undefined,
    });

    if (res.status >= 300 && res.status < 400) {
      let redirectUrl = res.headers.get('location');
      if (redirectUrl) {
        const redirectDepth = (ctx._redirectDepth || 0) + 1;
        if (redirectDepth > MAX_REDIRECTS) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
        }

        // Redirects cannot carry credentials from the original URL.
        const parsed = new URL(redirectUrl, url);
        parsed.username = '';
        parsed.password = '';
        redirectUrl = parsed.toString();

        await checkSSRF(redirectUrl);
        // Releasing the body prevents a redirect chain from retaining sockets.
        await res.body?.cancel().catch(() => {});
        return execute({ url: redirectUrl, rawContent, limit }, { ...ctx, _redirectDepth: redirectDepth });
      }
    }

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > LIMITS.fetchMaxSize) {
      throw new Error(
        `Response too large (${contentLength} bytes). Maximum allowed is ${LIMITS.fetchMaxSize} bytes (10MB).`,
      );
    }

    contentType = res.headers.get('content-type') || 'unknown';
    // Streaming reads enforce the size limit even without content-length.
    raw = await readBodyCapped(res, LIMITS.fetchMaxSize);
  } finally {
    clearTimeout(timeout);
    if (ctx.signal) {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  if (isBinaryContent(raw)) {
    throw new Error(`Binary content detected (content-type: ${contentType}). fetchUrl cannot process binary files.`);
  }

  if (contentType.includes('application/json')) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  if (contentType.includes('text/plain') || contentType.includes('text/csv') || contentType.includes('text/markdown')) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  if (rawContent) {
    return withContentType(contentType, truncateOutput(raw, limit));
  }

  const $ = cheerio.load(raw);
  $(
    'script, style, nav, footer, header, noscript, aside, iframe, form, svg, canvas, [aria-hidden="true"], [hidden], .hidden',
  ).remove();

  let cleanText = $('article, main, body').text();
  if (!cleanText || cleanText.trim().length < 100) {
    cleanText = $.text();
  }

  // Horizontal whitespace collapses while paragraph breaks remain visible.
  cleanText = cleanText
    .replace(/[ \t\xa0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return truncateOutput(cleanText, limit);
};

export const fetchUrl = { name: 'fetchUrl', description, inputSchema, execute };
