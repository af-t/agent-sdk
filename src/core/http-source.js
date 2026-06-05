import http from 'node:http';
import crypto from 'node:crypto';
import { ConfigError } from './errors.js';
import { logger } from './logger.js';

const VALID_AUTH = new Set(['none', 'token', 'hmac']);

export function createHttpSource(options = {}) {
  const {
    port,
    host = '127.0.0.1',
    routes = [],
    authToken,
    hmacSecret,
    signatureHeader = 'x-signature-256',
    signaturePrefix = 'sha256=',
    healthPath = '/health',
    responseTimeoutMs = 30000,
    bodyLimitBytes = 1_000_000,
    _transport = defaultTransport,
  } = options;

  if (!(typeof port === 'number' && port >= 0)) {
    throw new ConfigError('createHttpSource: port is required (a number >= 0)');
  }
  const routeList = Array.isArray(routes) ? routes : [];
  if (routeList.length === 0 && healthPath == null) {
    throw new ConfigError('createHttpSource: at least one route or a healthPath is required');
  }
  if (!(typeof responseTimeoutMs === 'number' && responseTimeoutMs > 0)) {
    throw new ConfigError('createHttpSource: responseTimeoutMs must be a positive number');
  }
  if (!(typeof bodyLimitBytes === 'number' && bodyLimitBytes > 0)) {
    throw new ConfigError('createHttpSource: bodyLimitBytes must be a positive number');
  }
  for (const r of routeList) {
    if (!r || typeof r.path !== 'string' || typeof r.type !== 'string') {
      throw new ConfigError('createHttpSource: every route needs a string path and type');
    }
    const auth = r.auth ?? 'none';
    if (!VALID_AUTH.has(auth)) {
      throw new ConfigError(`createHttpSource: route auth must be none|token|hmac, got '${auth}'`);
    }
    if (auth === 'token' && typeof authToken !== 'string') {
      throw new ConfigError('createHttpSource: a route uses auth:token but authToken is not set');
    }
    if (auth === 'hmac' && typeof hmacSecret !== 'string') {
      throw new ConfigError('createHttpSource: a route uses auth:hmac but hmacSecret is not set');
    }
  }

  const normRoutes = routeList.map((r) => ({
    method: (r.method ?? 'POST').toUpperCase(),
    path: r.path,
    type: r.type,
    auth: r.auth ?? 'none',
  }));

  let emitFn = null;
  let stopTransport = null;
  let started = false;
  let boundAddress = null;
  const pending = new Set();

  void authToken;
  void hmacSecret;
  void signatureHeader;
  void signaturePrefix;

  function safeEmit(event) {
    if (!emitFn) return;
    try {
      emitFn(event);
    } catch (err) {
      logger.warn(`http-source: emit threw: ${err.message}`);
    }
  }

  function matchRoute(method, path) {
    let pathSeen = false;
    for (const r of normRoutes) {
      if (r.path === path) {
        pathSeen = true;
        if (r.method === method) return r;
      }
    }
    return pathSeen ? 'method-not-allowed' : null;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > bodyLimitBytes) {
          reject(Object.assign(new Error('body too large'), { httpStatus: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function writeResponse(res, spec) {
    let status = 200;
    let headers = {};
    let body;
    if (typeof spec === 'string') {
      headers['content-type'] = 'text/plain; charset=utf-8';
      body = spec;
    } else if (spec && typeof spec === 'object') {
      status = spec.status ?? 200;
      headers = { ...(spec.headers ?? {}) };
      if (typeof spec.body === 'string') {
        body = spec.body;
      } else if (spec.body !== undefined) {
        if (headers['content-type'] == null) headers['content-type'] = 'application/json';
        body = JSON.stringify(spec.body);
      }
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  async function onRequest(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();
      const headers = req.headers ?? {};

      if (healthPath != null && method === 'GET' && path === healthPath) {
        writeResponse(res, { status: 200, body: { status: 'ok' } });
        return;
      }

      const route = matchRoute(method, path);
      if (route == null) {
        writeResponse(res, { status: 404, body: { error: 'not found' } });
        return;
      }
      if (route === 'method-not-allowed') {
        writeResponse(res, { status: 405, body: { error: 'method not allowed' } });
        return;
      }

      let rawBody;
      try {
        rawBody = await readBody(req);
      } catch (err) {
        if (err.httpStatus === 413) {
          logger.warn('http-source: request body exceeded limit');
          writeResponse(res, { status: 413, body: { error: 'payload too large' } });
          return;
        }
        throw err;
      }
      const body = rawBody;
      const query = Object.fromEntries(url.searchParams.entries());
      const requestId = crypto.randomBytes(4).toString('hex');

      await new Promise((resolve) => {
        let settled = false;
        const respond = (spec) => {
          if (settled) {
            logger.warn('http-source: respond called more than once; ignoring');
            return;
          }
          settled = true;
          clearTimeout(timer);
          pending.delete(entry);
          try {
            writeResponse(res, spec);
          } catch (err) {
            logger.warn(`http-source: failed to write response: ${err.message}`);
          }
          resolve();
        };
        const timer = setTimeout(() => respond({ status: 504, body: { error: 'timeout' } }), responseTimeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        const entry = { respond };
        pending.add(entry);

        safeEmit({
          type: route.type,
          method,
          path,
          query,
          headers,
          body,
          rawBody,
          ip: req.socket?.remoteAddress,
          requestId,
          respond,
        });
      });
    } catch (err) {
      logger.warn(`http-source: request pipeline threw: ${err.message}`);
      try {
        writeResponse(res, { status: 500, body: { error: 'internal error' } });
      } catch {
        // best-effort
      }
    }
  }

  return {
    start(emit) {
      if (started) {
        logger.warn('http-source already started; ignoring');
        return;
      }
      started = true;
      emitFn = emit;
      try {
        stopTransport = _transport({ host, port }, onRequest, (addr) => {
          boundAddress = addr;
        });
      } catch (err) {
        logger.warn(`http-source backend start threw: ${err.message}`);
      }
    },
    stop() {
      started = false;
      if (typeof stopTransport === 'function') {
        try {
          stopTransport();
        } catch (err) {
          logger.warn(`http-source backend stop threw: ${err.message}`);
        }
      }
      stopTransport = null;
      for (const entry of [...pending]) {
        entry.respond({ status: 503, body: { error: 'shutting down' } });
      }
      pending.clear();
      boundAddress = null;
      emitFn = null;
    },
    address() {
      return boundAddress;
    },
  };
}

function defaultTransport({ host, port }, onRequest, onListening) {
  const server = http.createServer((req, res) => {
    onRequest(req, res);
  });
  server.on('error', (err) => logger.warn(`http-source server error: ${err.message}`));
  server.listen(port, host, () => {
    const addr = server.address();
    if (onListening && addr && typeof addr === 'object') {
      onListening({ host: addr.address, port: addr.port });
    }
  });
  return () => server.close();
}
