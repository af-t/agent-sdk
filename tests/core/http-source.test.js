import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import http from 'node:http';
import crypto from 'node:crypto';
import { createHttpSource } from '../../src/core/http-source.js';
import { logger } from '../../src/core/logger.js';
import { createDaemon } from '../../src/core/daemon.js';

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

// Task 4 Tests

test('exposes the raw body and parsed body for a matched route', async () => {
  const ft = fakeTransport();
  let seen;
  const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
  src.start((e) => {
    seen = e;
    e.respond({ status: 200 });
  });
  ft.onRequest()(mockReq({ method: 'POST', url: '/c', body: 'hello-raw' }), mockRes());
  await tick();
  assert.equal(seen.rawBody, 'hello-raw');
  assert.equal(seen.body, 'hello-raw'); // no JSON content-type -> body is the raw string
  src.stop();
});

test('a body over bodyLimitBytes returns 413 and emits nothing', async () => {
  const ft = fakeTransport();
  const emitted = [];
  const src = createHttpSource({
    port: 0,
    routes: [{ path: '/c', type: 'c' }],
    bodyLimitBytes: 8,
    _transport: ft.transport,
  });
  src.start((e) => emitted.push(e));
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c', body: 'way-too-much-data' }), res);
  await tick();
  assert.equal(res.statusCode, 413);
  assert.equal(emitted.length, 0);
  src.stop();
});

// Task 5 Tests

test('token auth: passes with the right Bearer token, 401 otherwise', async () => {
  const ft = fakeTransport();
  const emitted = [];
  const src = createHttpSource({
    port: 0,
    authToken: 'sekret',
    routes: [{ path: '/c', type: 'c', auth: 'token' }],
    _transport: ft.transport,
  });
  src.start((e) => {
    emitted.push(e);
    e.respond({ status: 200 });
  });

  const okRes = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c', headers: { authorization: 'Bearer sekret' } }), okRes);
  await tick();
  assert.equal(okRes.statusCode, 200);

  const badRes = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c', headers: { authorization: 'Bearer nope' } }), badRes);
  await tick();
  assert.equal(badRes.statusCode, 401);

  const noneRes = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c' }), noneRes);
  await tick();
  assert.equal(noneRes.statusCode, 401);

  assert.equal(emitted.length, 1); // only the authorized request emitted
  src.stop();
});

test('hmac auth: passes with a valid signature, 401 on mismatch', async () => {
  const ft = fakeTransport();
  const secret = 'whsec';
  const body = JSON.stringify({ event: 'push' });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const src = createHttpSource({
    port: 0,
    hmacSecret: secret,
    routes: [{ path: '/wh', type: 'wh', auth: 'hmac' }],
    _transport: ft.transport,
  });
  src.start((e) => e.respond({ status: 202 }));

  const okRes = mockRes();
  ft.onRequest()(
    mockReq({
      method: 'POST',
      url: '/wh',
      headers: { 'content-type': 'application/json', 'x-signature-256': sig },
      body,
    }),
    okRes,
  );
  await tick();
  assert.equal(okRes.statusCode, 202);

  const badRes = mockRes();
  ft.onRequest()(
    mockReq({ method: 'POST', url: '/wh', headers: { 'x-signature-256': 'sha256=deadbeef' }, body }),
    badRes,
  );
  await tick();
  assert.equal(badRes.statusCode, 401);
  src.stop();
});

// Task 6 Tests

test('parses a JSON body into event.body when content-type is application/json', async () => {
  const ft = fakeTransport();
  let seen;
  const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
  src.start((e) => {
    seen = e;
    e.respond({ status: 200 });
  });
  ft.onRequest()(
    mockReq({ method: 'POST', url: '/c?x=1&y=two', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }),
    mockRes(),
  );
  await tick();
  assert.deepEqual(seen.body, { a: 1 });
  assert.deepEqual(seen.query, { x: '1', y: 'two' });
  assert.equal(typeof seen.requestId, 'string');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers['content-type'], 'application/json');
  src.stop();
});

test('returns 400 on malformed JSON', async () => {
  const ft = fakeTransport();
  const emitted = [];
  const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
  src.start((e) => emitted.push(e));
  const res = mockRes();
  ft.onRequest()(
    mockReq({ method: 'POST', url: '/c', headers: { 'content-type': 'application/json' }, body: '{bad json' }),
    res,
  );
  await tick();
  assert.equal(res.statusCode, 400);
  assert.equal(emitted.length, 0);
  src.stop();
});

// Task 7 Tests

test('respond() with a string sends text/plain 200', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
  src.start((e) => e.respond('pong'));
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c' }), res);
  await tick();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'pong');
  assert.match(res.headers['content-type'], /text\/plain/);
  src.stop();
});

test('respond() with an object spec sets status, headers, and a JSON body', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
  src.start((e) => e.respond({ status: 202, headers: { 'x-extra': 'yes' }, body: { queued: true } }));
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c' }), res);
  await tick();
  assert.equal(res.statusCode, 202);
  assert.equal(res.headers['x-extra'], 'yes');
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.body), { queued: true });
  src.stop();
});

test('a second respond() call is ignored', async () => {
  const ft = fakeTransport();
  const warns = [];
  const orig = logger.warn;
  logger.warn = (m) => warns.push(m);
  try {
    const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
    src.start((e) => {
      e.respond({ status: 200, body: { first: true } });
      e.respond({ status: 500, body: { second: true } });
    });
    const res = mockRes();
    ft.onRequest()(mockReq({ method: 'POST', url: '/c' }), res);
    await tick();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { first: true });
    assert.ok(warns.some((m) => /respond called more than once/.test(m)));
    src.stop();
  } finally {
    logger.warn = orig;
  }
});

test('a request times out with 504 when the handler never responds', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({
    port: 0,
    routes: [{ path: '/c', type: 'c' }],
    responseTimeoutMs: 20,
    _transport: ft.transport,
  });
  src.start(() => {}); // never calls respond
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c' }), res);
  await tick(60);
  assert.equal(res.statusCode, 504);
  src.stop();
});

// Task 8 Tests

test('stop() resolves an in-flight request with 503', async () => {
  const ft = fakeTransport();
  const src = createHttpSource({ port: 0, routes: [{ path: '/c', type: 'c' }], _transport: ft.transport });
  src.start(() => {}); // hold the request open (never responds)
  const res = mockRes();
  ft.onRequest()(mockReq({ method: 'POST', url: '/c' }), res);
  await tick();
  assert.equal(res.ended, false); // still pending
  src.stop();
  await tick();
  assert.equal(res.statusCode, 503);
  assert.equal(res.ended, true);
});

// Task 9 Tests

test('createHttpSource is re-exported from the package entry', async () => {
  const mod = await import('../../src/index.js');
  assert.equal(typeof mod.createHttpSource, 'function');
});

test('drives a daemon: handler awaits agent.run and replies with the result', async () => {
  const ft = fakeTransport();
  const agent = fakeAgent();
  const source = createHttpSource({
    port: 0,
    routes: [{ path: '/control', type: 'http-control' }],
    _transport: ft.transport,
  });
  const daemon = createDaemon({
    agent,
    sources: [source],
    handler: async (event, ctx) => {
      if (event.type === 'http-control') {
        const out = await ctx.agent.run(event.body.prompt, null, { signal: ctx.signal });
        event.respond({ status: 200, body: { result: out } });
        return null;
      }
    },
  });
  daemon.start();
  const res = mockRes();
  ft.onRequest()(
    mockReq({
      method: 'POST',
      url: '/control',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    }),
    res,
  );
  for (let i = 0; i < 50 && !res.ended; i++) await tick(5);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { result: 'ran' });
  assert.equal(agent.runs[0].prompt, 'hi');
  await daemon.stop();
});

test('real loopback: GET /health 200, an authorized control round-trip, then releases the port', async () => {
  const src = createHttpSource({
    port: 0,
    authToken: 'secret',
    routes: [{ path: '/control', type: 'http-control', auth: 'token' }],
  });
  src.start((e) => e.respond({ status: 200, body: { ok: true, prompt: e.body.prompt } }));
  for (let i = 0; i < 50 && !src.address(); i++) await tick(10);
  const { port } = src.address();

  const health = await request(port, { path: '/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });

  const ctrl = await request(port, {
    method: 'POST',
    path: '/control',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  assert.equal(ctrl.status, 200);
  assert.deepEqual(JSON.parse(ctrl.body), { ok: true, prompt: 'hello' });

  const unauth = await request(port, { method: 'POST', path: '/control', body: '{}' });
  assert.equal(unauth.status, 401);

  src.stop();
  await tick(40);
  await assert.rejects(() => request(port, { path: '/health' }));
});
