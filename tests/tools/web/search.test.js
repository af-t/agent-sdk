import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

function makeFetchResponse(body, { ok = true, status = 200, contentType = 'application/json' } = {}) {
  if (contentType === 'application/json') {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return {
    ok,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => body,
  };
}

describe('WebSearch tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/web/search.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'WebSearch');
  });

  it('should export description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('should export input_schema', () => {
    assert.ok(mod.input_schema);
    assert.strictEqual(mod.input_schema.type, 'object');
    assert.ok(mod.input_schema.properties);
    assert.ok(mod.input_schema.properties.query);
    assert.strictEqual(mod.input_schema.properties.query.type, 'string');
    assert.ok(mod.input_schema.required.includes('query'));
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });
});

describe('ddgJsonSearch()', () => {
  let ddgJsonSearch;
  let originalFetch;

  before(async () => {
    const mod = await import('../../../src/tools/web/search.js');
    ddgJsonSearch = mod.ddgJsonSearch;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('returns results from AbstractText and RelatedTopics', async () => {
    global.fetch = async () =>
      makeFetchResponse({
        AbstractText: 'Node.js is a JavaScript runtime built on V8.',
        AbstractURL: 'https://nodejs.org',
        Heading: 'Node.js',
        RelatedTopics: [
          { FirstURL: 'https://example.com/1', Text: 'First topic - A related description' },
          { FirstURL: 'https://example.com/2', Text: 'Second topic - Another description' },
        ],
      });

    const results = await ddgJsonSearch('nodejs', 5);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].url, 'https://nodejs.org');
    assert.strictEqual(results[0].title, 'Node.js');
    assert.ok(results[0].snippet.includes('JavaScript runtime'));
    assert.strictEqual(results[1].url, 'https://example.com/1');
    assert.strictEqual(results[2].url, 'https://example.com/2');
  });

  it('skips sub-heading topic groups (items with a .Topics array)', async () => {
    global.fetch = async () =>
      makeFetchResponse({
        AbstractText: '',
        AbstractURL: '',
        Heading: '',
        RelatedTopics: [
          { Topics: [{ FirstURL: 'https://sub.example.com', Text: 'Sub item' }] },
          { FirstURL: 'https://example.com/real', Text: 'Real topic' },
        ],
      });

    const results = await ddgJsonSearch('test', 5);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].url, 'https://example.com/real');
  });

  it('respects maxResults cap', async () => {
    global.fetch = async () =>
      makeFetchResponse({
        AbstractText: '',
        AbstractURL: '',
        Heading: '',
        RelatedTopics: [
          { FirstURL: 'https://example.com/1', Text: 'Topic 1' },
          { FirstURL: 'https://example.com/2', Text: 'Topic 2' },
          { FirstURL: 'https://example.com/3', Text: 'Topic 3' },
        ],
      });

    const results = await ddgJsonSearch('test', 2);
    assert.strictEqual(results.length, 2);
  });

  it('returns empty array when no results found', async () => {
    global.fetch = async () => makeFetchResponse({ AbstractText: '', AbstractURL: '', Heading: '', RelatedTopics: [] });

    const results = await ddgJsonSearch('xyznonexistent', 5);
    assert.strictEqual(results.length, 0);
  });

  it('throws on non-ok HTTP response', async () => {
    global.fetch = async () => makeFetchResponse({}, { ok: false, status: 503 });
    await assert.rejects(() => ddgJsonSearch('test', 5), /503/);
  });

  it('propagates AbortError when fetch is aborted', async () => {
    global.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(() => ddgJsonSearch('test', 5), { name: 'AbortError' });
  });

  it('uses full topic text as title when no " - " separator present', async () => {
    global.fetch = async () =>
      makeFetchResponse({
        AbstractText: '',
        AbstractURL: '',
        Heading: '',
        RelatedTopics: [{ FirstURL: 'https://example.com', Text: 'No separator here' }],
      });

    const results = await ddgJsonSearch('test', 5);
    assert.strictEqual(results[0].title, 'No separator here');
    assert.strictEqual(results[0].snippet, 'No separator here');
  });
});

describe('ddgHtmlSearch()', () => {
  let ddgHtmlSearch;
  let originalFetch;

  const MOCK_HTML = [
    '<html><body>',
    '<div class="result results_links results_links_deep web-result">',
    '<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&rut=abc">Example <b>Page</b> One</a></h2>',
    '<div class="result__extras"><div class="result__extras__url">example.com</div></div>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1">A snippet for <b>page</b> one</a>',
    '</div>',
    '<div class="result results_links results_links_deep web-result">',
    '<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2&rut=def">Example Page Two</a></h2>',
    '<div class="result__extras"><div class="result__extras__url">example.com/page2</div></div>',
    '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2">A snippet for page two</a>',
    '</div>',
    '</body></html>',
  ].join('\n');

  before(async () => {
    const mod = await import('../../../src/tools/web/search.js');
    ddgHtmlSearch = mod.ddgHtmlSearch;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('extracts titles, decoded URLs, and snippets from HTML', async () => {
    global.fetch = async () => makeFetchResponse(MOCK_HTML, { contentType: 'text/html' });

    const results = await ddgHtmlSearch('test', 5);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].url, 'https://example.com/page1');
    assert.strictEqual(results[0].title, 'Example Page One');
    assert.strictEqual(results[0].snippet, 'A snippet for page one');
    assert.strictEqual(results[1].url, 'https://example.com/page2');
    assert.strictEqual(results[1].title, 'Example Page Two');
  });

  it('decodes percent-encoded URLs from uddg param', async () => {
    const html = [
      '<html><body>',
      '<div class="result results_links results_links_deep web-result">',
      '<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2Fdocs%2F&rut=x">Python <b>Docs</b></a></h2>',
      '<div class="result__extras"><div class="result__extras__url">python.org</div></div>',
      '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.python.org%2Fdocs%2F">Python docs snippet</a>',
      '</div>',
      '</body></html>',
    ].join('\n');
    global.fetch = async () => makeFetchResponse(html, { contentType: 'text/html' });

    const results = await ddgHtmlSearch('python', 5);
    assert.strictEqual(results[0].url, 'https://www.python.org/docs/');
  });

  it('respects maxResults cap', async () => {
    global.fetch = async () => makeFetchResponse(MOCK_HTML, { contentType: 'text/html' });
    const results = await ddgHtmlSearch('test', 1);
    assert.strictEqual(results.length, 1);
  });

  it('returns empty array when no result__a links found', async () => {
    global.fetch = async () =>
      makeFetchResponse('<html><body><p>No results</p></body></html>', { contentType: 'text/html' });
    const results = await ddgHtmlSearch('xyznonexistent', 5);
    assert.strictEqual(results.length, 0);
  });

  it('throws on non-ok HTTP response', async () => {
    global.fetch = async () => makeFetchResponse('', { ok: false, status: 429, contentType: 'text/html' });
    await assert.rejects(() => ddgHtmlSearch('test', 5), /429/);
  });

  it('propagates AbortError when fetch is aborted', async () => {
    global.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(() => ddgHtmlSearch('test', 5), { name: 'AbortError' });
  });

  it('returns empty snippet when result block has no result__snippet', async () => {
    const html = [
      '<html><body>',
      '<div class="result results_links results_links_deep web-result">',
      '<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=x">Example</a></h2>',
      '<div class="result__extras"><div class="result__extras__url">example.com</div></div>',
      '</div>',
      '</body></html>',
    ].join('\n');
    global.fetch = async () => makeFetchResponse(html, { contentType: 'text/html' });
    const results = await ddgHtmlSearch('test', 5);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].snippet, '');
  });
});

describe('ddgSearch() + formatDdgResults()', () => {
  let ddgSearch;
  let formatDdgResults;
  let originalFetch;

  before(async () => {
    const mod = await import('../../../src/tools/web/search.js');
    ddgSearch = mod.ddgSearch;
    formatDdgResults = mod.formatDdgResults;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('falls through to HTML scraping when JSON throws a non-abort error', async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      if (url.includes('api.duckduckgo.com')) {
        return makeFetchResponse({}, { ok: false, status: 503 });
      }
      const html = [
        '<div class="result results_links results_links_deep web-result">',
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.com&rut=x">Fallback</a>',
        '<a class="result__snippet">Fallback snippet</a>',
        '</div>',
      ].join('\n');
      return makeFetchResponse(html, { contentType: 'text/html' });
    };

    const results = await ddgSearch('test', 5);
    assert.strictEqual(callCount, 2);
    assert.strictEqual(results[0].url, 'https://fallback.com');
    assert.strictEqual(results[0].snippet, 'Fallback snippet');
  });

  it('returns JSON results when DDG JSON API has results', async () => {
    global.fetch = async () =>
      makeFetchResponse({
        AbstractText: 'JavaScript info',
        AbstractURL: 'https://javascript.info',
        Heading: 'JavaScript',
        RelatedTopics: [],
      });

    const results = await ddgSearch('javascript', 5);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].url, 'https://javascript.info');
  });

  it('falls through to HTML scraping when JSON returns no results', async () => {
    let callCount = 0;
    global.fetch = async (url) => {
      callCount++;
      if (url.includes('api.duckduckgo.com')) {
        return makeFetchResponse({ AbstractText: '', AbstractURL: '', Heading: '', RelatedTopics: [] });
      }
      const html = [
        '<div class="result">',
        '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffallback.com&rut=x">Fallback Result</a>',
        '<a class="result__snippet">Fallback snippet</a>',
        '</div>',
      ].join('\n');
      return makeFetchResponse(html, { contentType: 'text/html' });
    };

    const results = await ddgSearch('obscure query', 5);
    assert.strictEqual(callCount, 2);
    assert.strictEqual(results[0].url, 'https://fallback.com');
    assert.strictEqual(results[0].title, 'Fallback Result');
  });

  it('formatDdgResults returns formatted markdown with [via DuckDuckGo] tag', () => {
    const results = [{ title: 'Example', url: 'https://example.com', snippet: 'A description' }];
    const output = formatDdgResults('test query', results);
    assert.ok(output.includes('[via DuckDuckGo]'));
    assert.ok(output.includes('https://example.com'));
    assert.ok(output.includes('Example'));
    assert.ok(output.includes('A description'));
    assert.ok(output.includes('test query'));
  });

  it('formatDdgResults returns "No results found." for empty array', () => {
    const output = formatDdgResults('test', []);
    assert.strictEqual(output, 'No results found.');
  });
});

describe('execute() — fallback when no TAVILY_API_KEY', () => {
  let execute;
  let originalFetch;
  let savedKey;

  before(async () => {
    const mod = await import('../../../src/tools/web/search.js');
    execute = mod.execute;
    originalFetch = global.fetch;
    savedKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
  });

  after(() => {
    global.fetch = originalFetch;
    if (savedKey !== undefined) process.env.TAVILY_API_KEY = savedKey;
    else delete process.env.TAVILY_API_KEY;
  });

  it('calls DuckDuckGo instead of Tavily when TAVILY_API_KEY is absent', async () => {
    let calledUrl = '';
    global.fetch = async (url) => {
      calledUrl = typeof url === 'string' ? url : url.toString();
      return makeFetchResponse({
        AbstractText: 'DuckDuckGo result',
        AbstractURL: 'https://ddg.gg',
        Heading: 'DDG',
        RelatedTopics: [],
      });
    };

    const result = await execute({ query: 'test' });
    assert.ok(calledUrl.includes('duckduckgo.com'), `Expected DDG URL, got: ${calledUrl}`);
    assert.ok(result.includes('[via DuckDuckGo]'));
  });

  it('returns "No results found." when both DDG sources return empty', async () => {
    global.fetch = async (url) => {
      if (url.includes('api.duckduckgo.com')) {
        return makeFetchResponse({ AbstractText: '', AbstractURL: '', Heading: '', RelatedTopics: [] });
      }
      return makeFetchResponse('<html><body></body></html>', { contentType: 'text/html' });
    };

    const result = await execute({ query: 'xyznonexistent' });
    assert.strictEqual(result, 'No results found.');
  });

  it('propagates timeout as a descriptive error', async () => {
    global.fetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(() => execute({ query: 'test' }), /timed out/);
  });
});
