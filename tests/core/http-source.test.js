import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpSource } from '../../src/core/http-source.js';

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
