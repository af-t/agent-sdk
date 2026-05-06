import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('WebFetch tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/web/fetch.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'WebFetch');
  });

  it('should export description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('should export input_schema', () => {
    assert.ok(mod.input_schema);
    assert.strictEqual(mod.input_schema.type, 'object');
    assert.ok(mod.input_schema.properties);
    assert.ok(mod.input_schema.properties.url);
    assert.ok(mod.input_schema.required.includes('url'));
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });

  describe('SSRF validation (via execute)', () => {
    it('should reject localhost hostname', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://localhost:8080/test' }),
        /Access denied: localhost\/internal host is not allowed/
      );
    });

    it('should reject 127.0.0.1 IP address', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://127.0.0.1:3000/' }),
        /Access denied: localhost\/internal host is not allowed/
      );
    });

    it('should reject 0.0.0.0', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://0.0.0.0/' }),
        /Access denied: localhost\/internal host is not allowed/
      );
    });

    it('should reject private IP 10.x.x.x', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://10.0.0.1/' }),
        /Access denied: private\/reserved IP range is not allowed/
      );
    });

    it('should reject private IP 192.168.x.x', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://192.168.1.1/' }),
        /Access denied: private\/reserved IP range is not allowed/
      );
    });

    it('should reject private IP 172.16.x.x', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://172.16.0.1/' }),
        /Access denied: private\/reserved IP range is not allowed/
      );
    });

    it('should reject private IP 172.31.x.x', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://172.31.255.255/' }),
        /Access denied: private\/reserved IP range is not allowed/
      );
    });

    it('should reject link-local 169.254.x.x', async () => {
      await assert.rejects(
        mod.execute({ url: 'http://169.254.1.1/' }),
        /Access denied: private\/reserved IP range is not allowed/
      );
    });

    it('should reject non-http protocol (file://)', async () => {
      await assert.rejects(
        mod.execute({ url: 'file:///etc/passwd' }),
        /Access denied: protocol/
      );
    });

    it('should reject non-http protocol (ftp://)', async () => {
      await assert.rejects(
        mod.execute({ url: 'ftp://ftp.example.com/' }),
        /Access denied: protocol/
      );
    });

    it('should reject invalid URL format', async () => {
      await assert.rejects(
        mod.execute({ url: 'not-a-url' }),
        /Invalid URL/
      );
    });

    it('should accept a valid public HTTPS URL (should not raise SSRF error)', async () => {
      await assert.doesNotReject(
        () => mod.execute({ url: 'https://example.com/' }),
        /Access denied/
      );
    });
  });
});
