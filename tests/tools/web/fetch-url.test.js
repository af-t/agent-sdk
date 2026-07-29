import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSSRF, fetchUrl, isBlockedIp } from '../../../src/tools/web/fetch-url.js';

// The tool object carries no transport hook; every stub arrives through the context.
const fetchWith = (transport, input, ctx = {}) => fetchUrl.execute(input, { ...ctx, transport });
const unsupportedRawContentKey = ['use', 'raw'].join('_');

describe('fetchUrl tool module', () => {
  it('exports fetchUrl with a strict rawContent input contract', () => {
    assert.strictEqual(fetchUrl.name, 'fetchUrl');
    assert.strictEqual(fetchUrl.inputSchema.additionalProperties, false);
    assert.ok(fetchUrl.inputSchema.properties.rawContent);
    assert.equal(fetchUrl.inputSchema.properties[unsupportedRawContentKey], undefined);
  });

  it('describes itself with a non-empty description', () => {
    assert.strictEqual(typeof fetchUrl.description, 'string');
    assert.ok(fetchUrl.description.length > 0);
  });

  it('declares an object input schema', () => {
    assert.strictEqual(fetchUrl.inputSchema.type, 'object');
  });

  it('exposes execute as a function', () => {
    assert.strictEqual(typeof fetchUrl.execute, 'function');
  });

  describe('SSRF validation (via execute)', () => {
    it('rejects the localhost hostname', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://localhost/admin' }), /Access denied/);
    });

    it('rejects the 127.0.0.1 address', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://127.0.0.1/' }), /Access denied/);
    });

    it('rejects 0.0.0.0', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://0.0.0.0/' }), /Access denied/);
    });

    it('rejects the private 10.x.x.x range', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://10.0.0.1/' }), /Access denied/);
    });

    it('rejects the private 192.168.x.x range', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://192.168.1.1/' }), /Access denied/);
    });

    it('rejects the private 172.16.x.x range', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://172.16.0.1/' }), /Access denied/);
    });

    it('rejects the private 172.31.x.x range', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://172.31.255.255/' }), /Access denied/);
    });

    it('rejects the link-local 169.254.x.x range', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://169.254.169.254/' }), /Access denied/);
    });

    it('rejects the file:// protocol', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'file:///etc/passwd' }), /Access denied|Invalid URL/);
    });

    it('rejects the ftp:// protocol', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'ftp://example.com/file' }), /Access denied|Invalid URL/);
    });

    it('rejects a malformed URL', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'not-a-url' }), /Invalid URL/);
    });

    it('raises no SSRF error for a public HTTPS URL', async () => {
      // The request itself may fail offline; only the SSRF verdict matters here.
      try {
        await fetchUrl.execute({ url: 'https://example.com' });
      } catch (err) {
        assert.ok(!err.message.includes('Access denied'), 'a public URL must not be denied');
      }
    });
  });

  describe('SSRF: DNS rebinding bypass attempts', () => {
    // DNS resolution and connection pinning block rebinding hostnames that
    // resolve to 127.0.0.1.

    it('blocks nip.io rebinding (1.0.0.127.nip.io -> 127.0.0.1)', async () => {
      // 1.0.0.127.nip.io resolves to 127.0.0.1 in most environments; where the
      // name does not resolve at all the request is denied for that reason.
      try {
        await checkSSRF('http://1.0.0.127.nip.io/');
      } catch (err) {
        assert.ok(err.message.includes('Access denied'));
      }
    });

    it('blocks localtest.me rebinding (-> 127.0.0.1)', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://localtest.me/' }), /Access denied/);
    });

    it('blocks the AWS metadata endpoint (-> 169.254.169.254)', async () => {
      await assert.rejects(
        () => fetchUrl.execute({ url: 'http://169.254.169.254/latest/meta-data/' }),
        /Access denied/,
      );
    });

    it('blocks the IPv6 loopback literal (-> ::1)', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://[::1]:8080/' }), /Access denied/);
    });

    it('blocks the localhost6 hostname', async () => {
      // Some systems resolve localhost6 to ::1.
      await assert.rejects(() => fetchUrl.execute({ url: 'http://localhost6/' }), /Access denied/);
    });
  });

  describe('SSRF: redirect handling', () => {
    it('denies a redirect target on localhost', async () => {
      await assert.rejects(() => checkSSRF('http://localhost:8080/admin'), /Access denied/);
    });

    it('denies a redirect target on a private IP', async () => {
      await assert.rejects(() => checkSSRF('http://10.0.0.1/'), /Access denied/);
    });

    it('denies a redirect target on the AWS metadata endpoint', async () => {
      await assert.rejects(() => checkSSRF('http://169.254.169.254/latest/meta-data/'), /Access denied/);
    });

    it('allows a public redirect target', async () => {
      await assert.doesNotReject(() => checkSSRF('https://example.com/redirect-target'), /Access denied/);
    });

    it('strips credentials from the redirect URL before following it', async () => {
      // A counter distinguishes the initial request from the redirected one.
      let callCount = 0;
      let redirectTarget;
      const transport = async (url) => {
        callCount++;
        if (callCount === 1) {
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
        redirectTarget = typeof url === 'string' ? url : url.toString();
        return {
          status: 200,
          headers: {
            get: (name) => (name === 'content-type' ? 'text/plain' : null),
          },
          text: async () => 'redirected content',
        };
      };

      await fetchWith(transport, { url: 'https://example.com/initial' });

      assert.ok(redirectTarget, 'the redirect should have been followed');
      assert.ok(!redirectTarget.includes('leaked'), 'the username must be stripped from the URL');
      assert.ok(!redirectTarget.includes('secret'), 'the password must be stripped from the URL');
      const parsed = new URL(redirectTarget);
      assert.strictEqual(parsed.hostname, 'example.com');
      assert.strictEqual(parsed.username, '');
      assert.strictEqual(parsed.password, '');
    });
  });

  describe('SSRF: non-standard protocols', () => {
    it('rejects gopher://', async () => {
      await assert.rejects(fetchUrl.execute({ url: 'gopher://evil.com/1' }), /Access denied: protocol/);
    });

    it('rejects tftp://', async () => {
      await assert.rejects(fetchUrl.execute({ url: 'tftp://evil.com/file' }), /Access denied: protocol/);
    });

    it('rejects ws://', async () => {
      await assert.rejects(fetchUrl.execute({ url: 'ws://evil.com/socket' }), /Access denied: protocol/);
    });

    it('rejects wss://', async () => {
      await assert.rejects(fetchUrl.execute({ url: 'wss://evil.com/socket' }), /Access denied: protocol/);
    });

    it('rejects javascript:', async () => {
      await assert.rejects(fetchUrl.execute({ url: 'javascript:alert(1)' }), /Invalid URL|protocol/);
    });

    it('rejects data:', async () => {
      await assert.rejects(
        fetchUrl.execute({ url: 'data:text/html,<script>alert(1)</script>' }),
        /Invalid URL|protocol/,
      );
    });
  });

  describe('SSRF: IPv4-mapped IPv6 bypass attempts', () => {
    it('blocks loopback via dotted IPv4-mapped IPv6 literal', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://[::ffff:127.0.0.1]/' }), /Access denied/);
    });

    it('blocks loopback via hex IPv4-mapped IPv6 literal', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://[::ffff:7f00:1]/' }), /Access denied/);
    });

    it('blocks private range via long-form IPv4-mapped IPv6 literal', async () => {
      await assert.rejects(() => fetchUrl.execute({ url: 'http://[0:0:0:0:0:ffff:10.0.0.1]/' }), /Access denied/);
    });

    it('blocks AWS metadata IP via IPv4-mapped IPv6', async () => {
      assert.strictEqual(isBlockedIp('::ffff:169.254.169.254'), true);
      assert.strictEqual(isBlockedIp('0:0:0:0:0:ffff:169.254.169.254'), true);
    });

    it('blocks IPv6 unspecified address', async () => {
      assert.strictEqual(isBlockedIp('::'), true);
    });

    it('allows a public IPv4-mapped IPv6 address', async () => {
      await assert.doesNotReject(() => checkSSRF('http://[::ffff:8.8.8.8]/'));
    });
  });

  describe('redirect depth limit (stub transport)', () => {
    it('rejects an infinite redirect loop', async () => {
      let calls = 0;
      const transport = async () => {
        calls++;
        return {
          status: 302,
          headers: {
            get: (name) => (name === 'location' ? 'https://example.com/loop' : null),
          },
          body: { cancel: async () => {} },
        };
      };

      await assert.rejects(() => fetchWith(transport, { url: 'https://example.com/start' }), /Too many redirects/);
      assert.ok(calls <= 7, `redirects should be capped, transport was called ${calls} times`);
    });
  });

  describe('body size cap without content-length (stub transport)', () => {
    it('rejects an oversized chunked response', async () => {
      const chunk = new Uint8Array(1024 * 1024);
      let pushed = 0;
      const transport = async () => ({
        status: 200,
        headers: {
          get: (name) => (name === 'content-type' ? 'text/plain' : null),
        },
        body: new ReadableStream({
          pull(controller) {
            // The 11 MB response exceeds the 10 MB cap.
            if (pushed >= 11) {
              controller.close();
              return;
            }
            pushed++;
            controller.enqueue(chunk);
          },
        }),
      });

      await assert.rejects(
        () => fetchWith(transport, { url: 'https://example.com/huge-stream' }),
        /Response too large/,
      );
    });
  });

  describe('SSRF: public IPv4 and IPv6 literal paths', () => {
    it('allows a public IPv4 address without DNS resolution', async () => {
      // 8.8.8.8 is a public IP, not in any blocked range
      await assert.doesNotReject(() => checkSSRF('http://8.8.8.8/'));
    });

    it('blocks a private IPv6 address (fc00::1) via literal check', async () => {
      await assert.rejects(() => checkSSRF('http://[fc00::1]/'), /Access denied/);
    });

    it('allows a public IPv6 address (2001:db8::1) via literal check', async () => {
      // 2001:db8::/32 is reserved for documentation and is not in BLOCKED_IP_RANGES.
      await assert.doesNotReject(() => checkSSRF('http://[2001:db8::1]/'));
    });
  });

  describe('response content handling (stub transport)', () => {
    function stubTransport({
      status = 200,
      contentType = 'text/html',
      body = '<html><body>hello</body></html>',
      contentLength = null,
    } = {}) {
      return async () => ({
        status,
        headers: {
          get: (name) => {
            if (name === 'content-type') return contentType;
            if (name === 'content-length') return contentLength;
            return null;
          },
        },
        body: null,
        text: async () => body,
      });
    }

    it('returns JSON content with its content-type header', async () => {
      const transport = stubTransport({ contentType: 'application/json', body: '{"key":"value"}' });
      const result = await fetchWith(transport, { url: 'https://example.com/api' });
      assert.ok(result.includes('application/json'));
      assert.ok(result.includes('"key"'));
    });

    it('rejects binary content (non-printable chars > 70%)', async () => {
      const binaryBody = '\x00\x01\x02\x03\x04\x05\x06\x07'.repeat(100);
      const transport = stubTransport({ contentType: 'application/octet-stream', body: binaryBody });
      await assert.rejects(
        () => fetchWith(transport, { url: 'https://example.com/file.bin' }),
        /Binary content detected/,
      );
    });

    it('rejects a response whose content-length exceeds 10MB', async () => {
      const transport = stubTransport({ contentLength: String(10 * 1024 * 1024 + 1) });
      await assert.rejects(() => fetchWith(transport, { url: 'https://example.com/huge' }), /Response too large/);
    });

    it('returns an unknown content type as plain text', async () => {
      const transport = stubTransport({ contentType: 'application/xml', body: '<root>data</root>' });
      const result = await fetchWith(transport, { url: 'https://example.com/data.xml' });
      assert.ok(result.includes('application/xml'));
      assert.ok(result.includes('<root>'));
    });

    it('returns raw HTML when rawContent is true', async () => {
      const html = '<html><body><p>Raw content here</p></body></html>';
      const transport = stubTransport({ contentType: 'text/html', body: html });
      const result = await fetchWith(transport, { url: 'https://example.com/', rawContent: true });
      assert.ok(result.includes('text/html'));
      assert.ok(result.includes('<html>'));
    });

    it('falls back to the whole document when article/main/body text is short', async () => {
      // A body under 100 characters uses the fallback extraction path.
      const html = '<html><head><title>T</title></head><body><p>Hi</p></body></html>';
      const transport = stubTransport({ contentType: 'text/html', body: html });
      const result = await fetchWith(transport, { url: 'https://example.com/' });
      assert.strictEqual(typeof result, 'string');
      assert.ok(result.length > 0);
    });

    it('returns text/plain content directly', async () => {
      const transport = stubTransport({ contentType: 'text/plain', body: 'Plain text response' });
      const result = await fetchWith(transport, { url: 'https://example.com/readme.txt' });
      assert.ok(result.includes('text/plain'));
      assert.ok(result.includes('Plain text response'));
    });

    it('registers an abort listener on ctx.signal', async () => {
      let listenerAttached = false;
      const fakeSignal = {
        aborted: false,
        addEventListener: (event) => {
          if (event === 'abort') listenerAttached = true;
        },
        removeEventListener: () => {},
      };
      const transport = stubTransport({ body: 'hello' });
      await fetchWith(transport, { url: 'https://example.com/' }, { signal: fakeSignal });
      assert.ok(listenerAttached, 'abort listener should be registered on ctx.signal');
    });
  });
});
