import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as WebFetchTool from '../../../src/tools/web/fetch.js';

describe('WebFetchTool', () => {
  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(WebFetchTool.name, 'WebFetch');
    assert.strictEqual(typeof WebFetchTool.description, 'string');
    assert.ok(WebFetchTool.input_schema);
  });

  it('should handle JSON responses', async () => {
    const mockResponse = {
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ test: 'data' })
    };
    mock.method(globalThis, 'fetch', async () => mockResponse);

    const result = await WebFetchTool.execute({ url: 'http://example.com' });
    assert.strictEqual(result, '{"test":"data"}');
  });

  it('should handle raw HTML response when useRaw is true', async () => {
    const htmlContent = '<html><body><h1>Hello</h1></body></html>';
    const mockResponse = {
      headers: new Map([['content-type', 'text/html']]),
      text: async () => htmlContent
    };
    mock.method(globalThis, 'fetch', async () => mockResponse);

    const result = await WebFetchTool.execute({ url: 'http://example.com', useRaw: true });
    assert.strictEqual(result, htmlContent);
  });

  it('should return cleaned HTML content by default', async () => {
    const htmlContent = `
      <html>
        <body>
          <nav>Skip me</nav>
          <main>
            <h1>Hello World</h1>
            <p>This is a test.</p>
          </main>
          <script>alert('skip')</script>
        </body>
      </html>
    `;
    const mockResponse = {
      headers: new Map([['content-type', 'text/html']]),
      text: async () => htmlContent
    };
    mock.method(globalThis, 'fetch', async () => mockResponse);

    const result = await WebFetchTool.execute({ url: 'http://example.com' });
    assert.match(result, /Hello World/);
    assert.match(result, /This is a test/);
    assert.doesNotMatch(result, /Skip me/);
    assert.doesNotMatch(result, /alert/);
  });

  it('should truncate response if limit is exceeded', async () => {
    const mockResponse = {
      headers: new Map([['content-type', 'application/json']]),
      text: async () => '1234567890'
    };
    mock.method(globalThis, 'fetch', async () => mockResponse);

    const result = await WebFetchTool.execute({ url: 'http://example.com', limit: 5 });
    assert.strictEqual(result, '12345\n[... truncated]');
  });

  it('should handle network errors gracefully', async () => {
    mock.method(globalThis, 'fetch', async () => { throw new Error('Network failure'); });

    const result = await WebFetchTool.execute({ url: 'http://example.com' });
    assert.match(result, /Fetch failed: Network failure/);
  });
});
