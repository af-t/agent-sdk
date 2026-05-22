import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { flattenNotebook } from '../../src/core/notebook.js';

function makeNb(cells, meta = {}) {
  return JSON.stringify({
    metadata: meta,
    nbformat: 4,
    nbformat_minor: 5,
    cells,
  });
}

function codeCell(source, outputs = []) {
  return { cell_type: 'code', source, outputs };
}

function markdownCell(source) {
  return { cell_type: 'markdown', source, outputs: [] };
}

describe('flattenNotebook', () => {
  it('throws on invalid JSON', () => {
    assert.throws(() => flattenNotebook('not json'), (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.startsWith('Invalid .ipynb:'), `unexpected message: ${err.message}`);
      return true;
    });
  });

  it('emits header with cell count and language from kernelspec', () => {
    const nb = makeNb([markdownCell('hello')], { kernelspec: { language: 'python' } });
    const result = flattenNotebook(nb);
    assert.ok(result.startsWith('[notebook] 1 cells, language: python\n\n'), `header mismatch: ${result.slice(0, 60)}`);
  });

  it('falls back to language_info.name when no kernelspec', () => {
    const nb = makeNb([markdownCell('hi')], { language_info: { name: 'julia' } });
    const result = flattenNotebook(nb);
    assert.ok(result.includes('language: julia'));
  });

  it('uses unknown when no language metadata', () => {
    const nb = makeNb([markdownCell('hi')]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('language: unknown'));
  });

  it('renders markdown cell', () => {
    const nb = makeNb([markdownCell('# Hello\nworld')]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('# Cell 1 [markdown]\n# Hello\nworld'));
  });

  it('joins source array for markdown cell', () => {
    const nb = makeNb([markdownCell(['line 1\n', 'line 2'])]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('line 1\nline 2'));
  });

  it('renders code cell without outputs', () => {
    const nb = makeNb([codeCell('print("hi")')]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('# Cell 1 [code]\nprint("hi")'));
    assert.ok(!result.includes('--- output ---'));
  });

  it('renders stream output', () => {
    const cell = codeCell('x = 1', [{ output_type: 'stream', text: 'hello stream\n' }]);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('--- output ---\nhello stream'));
  });

  it('renders execute_result with text/plain', () => {
    const cell = codeCell('1+1', [
      { output_type: 'execute_result', data: { 'text/plain': '2' } },
    ]);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('--- output ---\n2'));
  });

  it('renders display_data with image as placeholder', () => {
    const cell = codeCell('plot()', [
      { output_type: 'display_data', data: { 'image/png': 'base64data' } },
    ]);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('[image output omitted]'));
  });

  it('renders error output and strips ANSI escapes', () => {
    const cell = codeCell('raise ValueError("oops")', [
      {
        output_type: 'error',
        ename: 'ValueError',
        evalue: 'oops',
        traceback: ['[31mTraceback[0m', '  line 1'],
      },
    ]);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('ValueError: oops'));
    assert.ok(result.includes('Traceback'));
    assert.ok(!result.includes('['), `ANSI not stripped: ${result}`);
  });

  it('skips output section when outputs are empty', () => {
    const cell = codeCell('x = 1', []);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(!result.includes('--- output ---'));
  });

  it('uses 1-based cell numbering', () => {
    const nb = makeNb([markdownCell('a'), codeCell('b')]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('# Cell 1 [markdown]'));
    assert.ok(result.includes('# Cell 2 [code]'));
  });

  it('renders unknown cell_type', () => {
    const nb = makeNb([{ cell_type: 'raw', source: 'raw content', outputs: [] }]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('# Cell 1 [raw]\nraw content'));
  });

  it('joins stream text array', () => {
    const cell = codeCell('x', [{ output_type: 'stream', text: ['line a\n', 'line b\n'] }]);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('line a\nline b'));
  });

  it('renders display_data with jpeg as placeholder', () => {
    const cell = codeCell('img()', [
      { output_type: 'display_data', data: { 'image/jpeg': 'base64data' } },
    ]);
    const nb = makeNb([cell]);
    const result = flattenNotebook(nb);
    assert.ok(result.includes('[image output omitted]'));
  });

  it('cells separated by double newline', () => {
    const nb = makeNb([markdownCell('a'), markdownCell('b')]);
    const result = flattenNotebook(nb);
    // after header+blank there should be two cells separated by \n\n
    assert.ok(result.includes('# Cell 1 [markdown]\na\n\n# Cell 2 [markdown]\nb'));
  });
});
