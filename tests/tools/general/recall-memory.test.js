import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as tool from '../../../src/tools/general/recall-memory.js';

describe('RecallMemory tool', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-tool-'));
    await fs.writeFile(path.join(dir, 'gpg.md'), `---\ndescription: gpg signing rule\n---\nAll commits gpg signed.`);
    await fs.writeFile(path.join(dir, 'cake.md'), `---\ndescription: dessert\n---\nChocolate cake recipe.`);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('exports the required tool fields', () => {
    assert.equal(tool.name, 'RecallMemory');
    assert.ok(tool.description);
    assert.ok(tool.input_schema);
    assert.equal(typeof tool.execute, 'function');
  });

  it('formats ranked results from the lexical path (no apiKey)', async () => {
    const agent = {
      _memoryDir: dir,
      baseUrl: 'https://x',
      trustedPaths: new Set([dir]),
      usage: { cost: 0, tokens: 0 },
    };
    const out = await tool.execute({ query: 'gpg signing commits' }, { agent });
    assert.match(out, /Recalled memories/);
    assert.match(out, /gpg\.md/);
    assert.match(out, /All commits gpg signed/);
    assert.equal(agent.usage.tokens, 0); // lexical path has no usage
  });

  it('caps limit at 20 and floors below 1', async () => {
    const agent = {
      _memoryDir: dir,
      baseUrl: 'https://x',
      trustedPaths: new Set([dir]),
      usage: { cost: 0, tokens: 0 },
    };
    const out = await tool.execute({ query: 'x', limit: 999 }, { agent });
    assert.ok(out.length > 0); // does not throw on an out-of-range limit
    const out2 = await tool.execute({ query: 'x', limit: 0 }, { agent });
    assert.match(out2, /score/); // floored to 1, still returns a result
  });

  it('reports an empty store clearly', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-tool-empty-'));
    try {
      const agent = {
        _memoryDir: empty,
        baseUrl: 'https://x',
        trustedPaths: new Set([empty]),
        usage: { cost: 0, tokens: 0 },
      };
      const out = await tool.execute({ query: 'x' }, { agent });
      assert.match(out, /No memories are stored/);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('folds embedding usage into agent.usage (embeddings path, fetch stubbed)', async () => {
    const original = global.fetch;
    global.fetch = async (url) => {
      assert.match(url, /\/embeddings$/);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              { index: 0, embedding: [1, 0] },
              { index: 1, embedding: [1, 0] },
              { index: 2, embedding: [0, 1] },
            ],
            usage: { total_tokens: 30 },
          }),
      };
    };
    const fresh = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-tool-emb-'));
    try {
      await fs.writeFile(path.join(fresh, 'a.md'), `---\ndescription: one\n---\nfirst`);
      await fs.writeFile(path.join(fresh, 'b.md'), `---\ndescription: two\n---\nsecond`);
      const agent = {
        apiKey: 'sk-x',
        baseUrl: 'https://openrouter.ai/api/v1',
        embeddingModel: 'm',
        _memoryDir: fresh,
        trustedPaths: new Set([fresh]),
        usage: { cost: 0, tokens: 0 },
      };
      await tool.execute({ query: 'q' }, { agent });
      assert.equal(agent.usage.tokens, 30);
    } finally {
      global.fetch = original;
      await fs.rm(fresh, { recursive: true, force: true });
    }
  });
});
