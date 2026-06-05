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

  // Wired up in later tasks; referenced here so the closure compiles.
  void normRoutes;
  void host;
  void authToken;
  void hmacSecret;
  void signatureHeader;
  void signaturePrefix;
  void healthPath;
  void responseTimeoutMs;
  void bodyLimitBytes;
  void _transport;

  return {
    start() {},
    stop() {},
    address() {
      return null;
    },
  };
}

function defaultTransport() {
  return () => {};
}
