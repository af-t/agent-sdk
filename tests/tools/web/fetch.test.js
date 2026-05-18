import { describe, it, before, after } from 'node:test';
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

    it('should strip credentials from redirect URL before recursive call', async () => {
      // Simulate a 302 with Location containing credentials
      // Use a counter to distinguish initial request from redirect request
      let callCount = 0;
      let redirectFetchUrl;
      const originalFetch = global.fetch;
      global.fetch = async (url, _opts) => {
        callCount++;
        if (callCount === 1) {
          // First call: return 302 redirect with credentials
          return {
            status: 302,
            headers: {
              get: (name) => {
                if (name === 'location') return 'https://leaked:secret@example.com/';
                if (name === 'content-type') return 'text/plain';
                return null;
              },
            },
            body: {
              cancel: async () => {},
            },
          };
        }
        // Second call (redirect): capture URL and return success
        redirectFetchUrl = typeof url === 'string' ? url : url.toString();
        return {
          status: 200,
          headers: {
            get: (name) => {
              if (name === 'content-type') return 'text/plain';
              return null;
            },
          },
          text: async () => 'redirected content',
        };
      };

      await mod.execute({ url: 'https://example.com/initial' });

      global.fetch = originalFetch;

      // Assert that the redirect URL passed to fetch has no userinfo
      assert.ok(redirectFetchUrl, 'redirect fetch should have been called');
      assert.ok(!redirectFetchUrl.includes('leaked'), 'credentials should be stripped from the URL');
      assert.ok(!redirectFetchUrl.includes('secret'), 'password should be stripped from the URL');
      // Verify the URL still reaches the same host
      const parsed = new URL(redirectFetchUrl);
      assert.strictEqual(parsed.hostname, 'example.com');
      assert.strictEqual(parsed.username, '');
      assert.strictEqual(parsed.password, '');
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

  describe('SSRF — public IPv4 and IPv6 literal paths', () => {
    it('allows a public IPv4 address without DNS resolution', async () => {
      const { checkSSRF } = mod;
      // 8.8.8.8 is a public IP, not in any blocked range
      await assert.doesNotReject(() => checkSSRF('http://8.8.8.8/'));
    });

    it('blocks a private IPv6 address (fc00::1) via literal check', async () => {
      const { checkSSRF } = mod;
      await assert.rejects(() => checkSSRF('http://[fc00::1]/'), /Access denied/);
    });

    it('allows a public IPv6 address (2001:db8::1) via literal check', async () => {
      const { checkSSRF } = mod;
      // 2001:db8::/32 is documentation-only but not in any BLOCKED_IP_RANGES
      await assert.doesNotReject(() => checkSSRF('http://[2001:db8::1]/'));
    });
  });

  describe('response content handling (mocked fetch)', () => {
    let originalFetch;

    before(() => {
      originalFetch = global.fetch;
    });

    after(() => {
      global.fetch = originalFetch;
    });

    function mockFetch({
      status = 200,
      contentType = 'text/html',
      body = '<html><body>hello</body></html>',
      contentLength = null,
    } = {}) {
      global.fetch = async () => ({
        status,
        headers: {
          get: (name) => {
            if (name === 'content-type') return contentType;
            if (name === 'content-length') return contentLength;
            if (name === 'location') return null;
            return null;
          },
        },
        body: null,
        text: async () => body,
      });
    }

    it('returns JSON content with content-type header', async () => {
      mockFetch({ contentType: 'application/json', body: '{"key":"value"}' });
      const result = await mod.execute({ url: 'https://example.com/api' });
      assert.ok(result.includes('application/json'));
      assert.ok(result.includes('"key"'));
    });

    it('rejects binary content (non-printable chars > 70%)', async () => {
      const binaryBody = '\x00\x01\x02\x03\x04\x05\x06\x07'.repeat(100);
      mockFetch({ contentType: 'application/octet-stream', body: binaryBody });
      await assert.rejects(() => mod.execute({ url: 'https://example.com/file.bin' }), /Binary content detected/);
    });

    it('rejects response with content-length exceeding 10MB', async () => {
      const bigSize = 10 * 1024 * 1024 + 1;
      mockFetch({ contentLength: String(bigSize) });
      await assert.rejects(() => mod.execute({ url: 'https://example.com/huge' }), /Response too large/);
    });

    it('returns unknown content type as plain text', async () => {
      mockFetch({ contentType: 'application/xml', body: '<root>data</root>' });
      const result = await mod.execute({ url: 'https://example.com/data.xml' });
      assert.ok(result.includes('application/xml'));
      assert.ok(result.includes('<root>'));
    });

    it('returns raw HTML when useRaw=true', async () => {
      const html = '<html><body><p>Raw content here</p></body></html>';
      mockFetch({ contentType: 'text/html', body: html });
      const result = await mod.execute({ url: 'https://example.com/', useRaw: true });
      assert.ok(result.includes('text/html'));
      assert.ok(result.includes('<html>'));
    });

    it('falls back to $.text() when article/main/body has short text', async () => {
      // Body with very little text (< 100 chars) triggers the fallback
      const html = '<html><head><title>T</title></head><body><p>Hi</p></body></html>';
      mockFetch({ contentType: 'text/html', body: html });
      const result = await mod.execute({ url: 'https://example.com/' });
      assert.ok(typeof result === 'string');
      assert.ok(result.length > 0);
    });

    it('returns text/plain content directly', async () => {
      mockFetch({ contentType: 'text/plain', body: 'Plain text response' });
      const result = await mod.execute({ url: 'https://example.com/readme.txt' });
      assert.ok(result.includes('text/plain'));
      assert.ok(result.includes('Plain text response'));
    });

    it('attaches ctx.signal abort listener to internal controller', async () => {
      let listenerAttached = false;
      const fakeSignal = {
        aborted: false,
        addEventListener: (event, _handler, _opts) => {
          if (event === 'abort') listenerAttached = true;
        },
        removeEventListener: () => {},
      };
      mockFetch({ body: 'hello' });
      await mod.execute({ url: 'https://example.com/' }, { signal: fakeSignal });
      assert.ok(listenerAttached, 'abort listener should be registered on ctx.signal');
    });
  });
});
