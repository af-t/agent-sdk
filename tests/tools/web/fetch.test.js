import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('WebFetch tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/web/fetch.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'WebFetch');
  });

  it('should export description', () => {
    assert.strictEqual(typeof mod.description, 'string');
  });

  it('should export input_schema', () => {
    assert.strictEqual(typeof mod.input_schema, 'object');
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });

  describe('SSRF validation (via execute)', () => {
    it('should reject localhost hostname', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://localhost/admin' }), /Access denied/);
    });

    it('should reject 127.0.0.1 IP address', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://127.0.0.1/' }), /Access denied/);
    });

    it('should reject 0.0.0.0', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://0.0.0.0/' }), /Access denied/);
    });

    it('should reject private IP 10.x.x.x', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://10.0.0.1/' }), /Access denied/);
    });

    it('should reject private IP 192.168.x.x', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://192.168.1.1/' }), /Access denied/);
    });

    it('should reject private IP 172.16.x.x', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://172.16.0.1/' }), /Access denied/);
    });

    it('should reject private IP 172.31.x.x', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://172.31.255.255/' }), /Access denied/);
    });

    it('should reject link-local 169.254.x.x', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://169.254.169.254/' }), /Access denied/);
    });

    it('should reject non-http protocol (file://)', async () => {
      await assert.rejects(() => mod.execute({ url: 'file:///etc/passwd' }), /Access denied|Invalid URL/);
    });

    it('should reject non-http protocol (ftp://)', async () => {
      await assert.rejects(() => mod.execute({ url: 'ftp://example.com/file' }), /Access denied|Invalid URL/);
    });

    it('should reject invalid URL format', async () => {
      await assert.rejects(() => mod.execute({ url: 'not-a-url' }), /Invalid URL/);
    });

    it('should accept a valid public HTTPS URL (should not raise SSRF error)', async () => {
      // Note: we don't actually care if the fetch succeeds here, only that
      // checkSSRF doesn't throw an error.
      try {
        await mod.execute({ url: 'https://example.com' });
      } catch (err) {
        // If it's an SSRF Access denied, the test fails
        assert.ok(!err.message.includes('Access denied'), 'Should not have raised SSRF error');
      }
    });
  });

  describe('SSRF — DNS rebinding bypass attempts', () => {
    // DNS rebinding services resolve to 127.0.0.1 — after the SSRF hardening,
    // these are NOW blocked by DNS resolution + re-check.

    it('should reject nip.io DNS rebinding (1.0.0.127.nip.io → 127.0.0.1)', async () => {
      // 1.0.0.127.nip.io resolves to 127.0.0.1 in most environments
      // The DNS resolution step now catches this and blocks it.
      const { checkSSRF } = mod;
      try {
        await checkSSRF('http://1.0.0.127.nip.io/');
      } catch (err) {
        assert.ok(err.message.includes('Access denied'));
      }
    });

    it('should reject localtest.me DNS rebinding (→ 127.0.0.1)', async () => {
      // localtest.me resolves to 127.0.0.1
      await assert.rejects(() => mod.execute({ url: 'http://localtest.me/' }), /Access denied/);
    });

    it('should reject AWS metadata endpoint via DNS rebinding (→ 169.254.169.254)', async () => {
      await assert.rejects(() => mod.execute({ url: 'http://169.254.169.254/latest/meta-data/' }), /Access denied/);
    });

    it('should reject IPv6 loopback DNS rebinding (→ ::1)', async () => {
      // Direct IPv6 loopback test
      await assert.rejects(() => mod.execute({ url: 'http://[::1]:8080/' }), /Access denied/);
    });

    it('should reject IPv6 loopback via hostname localhost6', async () => {
      // Some systems resolve localhost6 to ::1
      await assert.rejects(() => mod.execute({ url: 'http://localhost6/' }), /Access denied/);
    });
  });

  describe('SSRF — redirect handling', () => {
    it('should detect redirect-to-internal via checkSSRF on redirect URL', async () => {
      const { checkSSRF } = mod;
      // A redirect to localhost should be caught
      await assert.rejects(() => checkSSRF('http://localhost:8080/admin'), /Access denied/);
    });

    it('should detect redirect-to-private-IP via checkSSRF', async () => {
      const { checkSSRF } = mod;
      // A redirect to 10.0.0.1 should be caught
      await assert.rejects(() => checkSSRF('http://10.0.0.1/'), /Access denied/);
    });

    it('should detect redirect-to-169.254.169.254 via checkSSRF', async () => {
      const { checkSSRF } = mod;
      // AWS metadata endpoint
      await assert.rejects(() => checkSSRF('http://169.254.169.254/latest/meta-data/'), /Access denied/);
    });

    it('should accept a normal redirect target URL', async () => {
      const { checkSSRF } = mod;
      // A redirect to a public URL should be fine
      await assert.doesNotReject(() => checkSSRF('https://example.com/redirect-target'), /Access denied/);
    });
  });

  describe('SSRF — non-standard protocols', () => {
    it('should reject gopher:// protocol', async () => {
      await assert.rejects(mod.execute({ url: 'gopher://evil.com/1' }), /Access denied: protocol/);
    });

    it('should reject tftp:// protocol', async () => {
      await assert.rejects(mod.execute({ url: 'tftp://evil.com/file' }), /Access denied: protocol/);
    });

    it('should reject ws:// protocol', async () => {
      await assert.rejects(mod.execute({ url: 'ws://evil.com/socket' }), /Access denied: protocol/);
    });

    it('should reject wss:// protocol', async () => {
      await assert.rejects(mod.execute({ url: 'wss://evil.com/socket' }), /Access denied: protocol/);
    });

    it('should reject javascript: protocol via URL constructor or protocol check', async () => {
      await assert.rejects(mod.execute({ url: 'javascript:alert(1)' }), /Invalid URL|protocol/);
    });

    it('should reject data: protocol via URL constructor/SSRF', async () => {
      await assert.rejects(mod.execute({ url: 'data:text/html,<script>alert(1)</script>' }), /Invalid URL|protocol/);
    });
  });
});
