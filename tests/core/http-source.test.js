import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import http from 'node:http';
import { createHttpSource } from '../../src/core/http-source.js';
import { logger } from '../../src/core/logger.js';

// Appendix B test helpers

// Captures onRequest so tests can drive synthetic requests; records start/stop counts.
function fakeTransport({ address = null } = {}) {
  let onRequest = null;
  let config = null;
  let starts = 0;
  let stops = 0;
  return {
    transport: (cfg, handler, onListening) => {
      starts += 1;
      config = cfg;
      onRequest = handler;
      if (onListening) onListening(address ?? { host: cfg.host, port: cfg.port || 12345 });
      return () => {
        stops += 1;
      };
    },
    onRequest: () => onRequest,
    config: () => config,
    starts: () => starts,
    stops: () => stops,
  };
}

// A minimal IncomingMessage double: a Readable carrying the body plus method/url/headers/socket.
function mockReq({ method = 'POST', url = '/', headers = {}, body = '' } = {}) {
  const r = Readable.from([Buffer.from(body)]);
  r.method = method;
  r.url = url;
  r.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  r.socket = { remoteAddress: '127.0.0.1' };
  return r;
}

// A minimal ServerResponse double capturing status, headers, and the body.
function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: undefined,
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers ?? {};
      return this;
    },
    end(body) {
      this.body = body;
      this.ended = true;
    },
  };
}

function tick(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

// Real loopback HTTP client for the smoke test.
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Agent double mirroring tests/core/daemon.test.js.
function fakeAgent({ running = false } = {}) {
  let _running = running;
  const runs = [];
  const steers = [];
  return {
    get isRunning() {
      return _running;
    },
    setRunning(v) {
      _running = v;
    },
    async run(prompt, notify, opts) {
      runs.push({ prompt, notify, opts });
      return 'ran';
    },
    steer(prompt) {
      steers.push(prompt);
      return _running;
    },
    runs,
    steers,
  };
}

// Task 1 Tests

test('throws ConfigError when port is missing or not a non-negative number', () => {
  assert.throws(() => createHttpSource({ routes: [{ path: '/x', type: 'x' }] }), /port is required/);
  assert.throws(() => createHttpSource({ port: -1, routes: [{ path: '/x', type: 'x' }] }), /port is required/);
  assert.throws(() => createHttpSource({ port: '8080', routes: [{ path: '/x', type: 'x' }] }), /port is required/);
});

test('throws when neither routes nor healthPath is present', () => {
  assert.throws(
    () => createHttpSource({ port: 0, routes: [], healthPath: null }),
    /at least one route or a healthPath/,
  );
});

test('throws when a route is missing path or type', () => {
  assert.throws(() => createHttpSource({ port: 0, routes: [{ type: 'x' }] }), /string path and type/);
  assert.throws(() => createHttpSource({ port: 0, routes: [{ path: '/x' }] }), /string path and type/);
});

test('throws on an unknown route auth mode', () => {
  assert.throws(
    () => createHttpSource({ port: 0, routes: [{ path: '/x', type: 'x', auth: 'basic' }] }),
    /none\|token\|hmac/,
  );
});

test('throws when a route needs a secret that is not configured', () => {
  assert.throws(
    () => createHttpSource({ port: 0, routes: [{ path: '/x', type: 'x', auth: 'token' }] }),
    /auth:token but authToken/,
  );
  assert.throws(
    () => createHttpSource({ port: 0, routes: [{ path: '/x', type: 'x', auth: 'hmac' }] }),
    /auth:hmac but hmacSecret/,
  );
});

test('throws on non-positive responseTimeoutMs and bodyLimitBytes', () => {
  assert.throws(() => createHttpSource({ port: 0, healthPath: '/h', responseTimeoutMs: 0 }), /responseTimeoutMs/);
  assert.throws(() => createHttpSource({ port: 0, healthPath: '/h', bodyLimitBytes: -5 }), /bodyLimitBytes/);
});

test('returns a source object with start, stop, and address', () => {
  const src = createHttpSource({ port: 0, healthPath: '/health' });
  assert.equal(typeof src.start, 'function');
  assert.equal(typeof src.stop, 'function');
  assert.equal(typeof src.address, 'function');
  assert.equal(src.address(), null);
});

// Task 2 Tests

test('start passes the resolved config to the transport and captures onRequest', () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 8080, host: '0.0.0.0', healthPath: '/health', _transport: ft.transport });
  src.start(() => {});
  assert.deepEqual(ft.config(), { host: '0.0.0.0', port: 8080 });
  assert.equal(typeof ft.onRequest(), 'function');
  src.stop();
});

test('address() reflects the onListening callback', () => {
  const ft = fakeTransport({ address: { host: '127.0.0.1', port: 4321 } });
  const src = createHttpSource({ port: 0, healthPath: '/health', _transport: ft.transport });
  assert.equal(src.address(), null);
  src.start(() => {});
  assert.deepEqual(src.address(), { host: '127.0.0.1', port: 4321 });
  src.stop();
  assert.equal(src.address(), null);
});

test('a second start warns and does not start the transport twice', () => {
  const ft = fakeTransport();
  const warns = [];
  const orig = logger.warn;
  logger.warn = (m) => warns.push(m);
  try {
    const src = createHttpSource({ port: 0, healthPath: '/health', _transport: ft.transport });
    src.start(() => {});
    src.start(() => {});
    assert.equal(ft.starts(), 1);
    assert.ok(warns.some((m) => /already started/.test(m)));
    src.stop();
  } finally {
    logger.warn = orig;
  }
});

test('stop is idempotent and safe before start', () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 0, healthPath: '/health', _transport: ft.transport });
  src.stop(); // before start
  src.start(() => {});
  src.stop();
  src.stop();
  assert.equal(ft.stops(), 1);
});

// Task 3 Tests

test('GET healthPath returns 200 {status:ok} and emits nothing', async () => {
  const ft = fakeTransport();
  const emitted = [];
  const src = createHttpSource({ port: 0, healthPath: '/health', _transport: ft.transport });
  src.start((e) => emitted.push(e));
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'GET', url: '/health' }), res);
  await tick();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
  assert.equal(emitted.length, 0);
  src.stop();
});

test('an unmatched path returns 404', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 0, routes: [{ path: '/control', type: 'ctl' }], _transport: ft.transport });
  src.start(() => {});
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/nope' }), res);
  await tick();
  assert.equal(res.statusCode, 404);
  src.stop();
});

test('a known path with the wrong method returns 405', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 0, routes: [{ path: '/control', type: 'ctl' }], _transport: ft.transport });
  src.start(() => {});
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'GET', url: '/control' }), res);
  await tick();
  assert.equal(res.statusCode, 405);
  src.stop();
});

test('a matched route emits an event and respond writes the HTTP response', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({
    port: 0,
    routes: [{ path: '/control', type: 'http-control' }],
    _transport: ft.transport,
  });
  src.start((e) => e.respond({ status: 200, body: { saw: e.type, path: e.path } }));
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/control' }), res);
  await tick();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { saw: 'http-control', path: '/control' });
  src.stop();
});
