import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recallMemories, parseMemoryFile } from '../../src/core/memory-recall.js';

describe('parseMemoryFile', () => {
  it('strips frontmatter and extracts the description', () => {
    const raw = `---\nname: x\ndescription: "a quoted summary"\ntype: project\n---\n\nThe body text.`;
    const { description, body } = parseMemoryFile(raw);
    assert.equal(description, 'a quoted summary');
    assert.equal(body, 'The body text.');
  });

  it('handles a file with no frontmatter', () => {
    const { description, body } = parseMemoryFile('just a body');
    assert.equal(description, '');
    assert.equal(body, 'just a body');
  });
});

describe('recallMemories (lexical path, no apiKey)', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-lex-'));
    await fs.writeFile(
      path.join(dir, 'gpg.md'),
      `---\ndescription: gpg signing rule\n---\nAll commits must be gpg signed with -S.`,
    );
    await fs.writeFile(
      path.join(dir, 'cake.md'),
      `---\ndescription: dessert recipe\n---\nChocolate cake with flour and sugar.`,
    );
    await fs.writeFile(path.join(dir, 'MEMORY.md'), `- index line that must be ignored`);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ranks the relevant memory first and excludes MEMORY.md', async () => {
    const out = await recallMemories({ memoryDir: dir, query: 'gpg signing commits', trustedPaths: new Set([dir]) });
    assert.equal(out.ranker, 'lexical');
    assert.equal(out.total, 2);
    assert.equal(out.results[0].name, 'gpg.md');
    assert.ok(!out.results.some((r) => r.name === 'MEMORY.md'));
    assert.match(out.results[0].body, /gpg signed/);
  });

  it('honors limit', async () => {
    const out = await recallMemories({ memoryDir: dir, query: 'anything', limit: 1, trustedPaths: new Set([dir]) });
    assert.equal(out.results.length, 1);
  });

  it('returns an empty result for a missing/empty directory', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-empty-'));
    try {
      const out = await recallMemories({ memoryDir: empty, query: 'x', trustedPaths: new Set([empty]) });
      assert.deepEqual(out.results, []);
      assert.equal(out.total, 0);
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});

describe('recallMemories (embeddings path)', () => {
  let dir;
  // fake embedder: 'alpha' texts -> [1,0], everything else -> [0,1].
  function makeEmbed(calls) {
    return async (inputs) => {
      calls.push(inputs);
      return {
        vectors: inputs.map((t) => (/alpha/i.test(t) ? [1, 0] : [0, 1])),
        usage: { total_tokens: 3 * inputs.length },
      };
    };
  }

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-emb-'));
    await fs.writeFile(path.join(dir, 'a.md'), `---\ndescription: alpha topic\n---\nalpha body`);
    await fs.writeFile(path.join(dir, 'b.md'), `---\ndescription: beta topic\n---\nbeta body`);
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('ranks by embeddings, writes the sidecar, and reports usage', async () => {
    const calls = [];
    const out = await recallMemories({
      memoryDir: dir,
      query: 'alpha please',
      apiKey: 'sk-x',
      baseUrl: 'https://x',
      model: 'm1',
      trustedPaths: new Set([dir]),
      _embed: makeEmbed(calls),
    });
    assert.equal(out.ranker, 'embeddings');
    assert.equal(out.results[0].name, 'a.md');
    assert.equal(out.usage.total_tokens, 9); // query + 2 files = 3 inputs * 3
    // first call embeds query + both files
    assert.equal(calls[0].length, 3);
    const sidecar = JSON.parse(await readFile(path.join(dir, '.embeddings.json'), 'utf8'));
    assert.ok(sidecar.entries['a.md'] && sidecar.entries['b.md']);
  });

  it('reuses cached vectors on an unchanged second call (only the query is embedded)', async () => {
    const calls = [];
    await recallMemories({
      memoryDir: dir,
      query: 'alpha again',
      apiKey: 'sk-x',
      baseUrl: 'https://x',
      model: 'm1',
      trustedPaths: new Set([dir]),
      _embed: makeEmbed(calls),
    });
    assert.equal(calls[0].length, 1); // only the query
  });

  it('re-embeds only a changed file', async () => {
    await fs.writeFile(path.join(dir, 'b.md'), `---\ndescription: beta topic\n---\nbeta body EDITED`);
    const calls = [];
    await recallMemories({
      memoryDir: dir,
      query: 'alpha once more',
      apiKey: 'sk-x',
      baseUrl: 'https://x',
      model: 'm1',
      trustedPaths: new Set([dir]),
      _embed: makeEmbed(calls),
    });
    assert.equal(calls[0].length, 2); // query + changed b.md
  });

  it('re-embeds everything when the model changes', async () => {
    const calls = [];
    await recallMemories({
      memoryDir: dir,
      query: 'alpha new model',
      apiKey: 'sk-x',
      baseUrl: 'https://x',
      model: 'm2',
      trustedPaths: new Set([dir]),
      _embed: makeEmbed(calls),
    });
    assert.equal(calls[0].length, 3); // model change invalidates both hashes
  });

  it('prunes deleted files from the sidecar', async () => {
    await fs.rm(path.join(dir, 'b.md'));
    const calls = [];
    await recallMemories({
      memoryDir: dir,
      query: 'alpha prune',
      apiKey: 'sk-x',
      baseUrl: 'https://x',
      model: 'm2',
      trustedPaths: new Set([dir]),
      _embed: makeEmbed(calls),
    });
    const sidecar = JSON.parse(await readFile(path.join(dir, '.embeddings.json'), 'utf8'));
    assert.ok(sidecar.entries['a.md']);
    assert.ok(!sidecar.entries['b.md']);
  });

  it('falls back to lexical when the embedder throws', async () => {
    const out = await recallMemories({
      memoryDir: dir,
      query: 'alpha',
      apiKey: 'sk-x',
      baseUrl: 'https://x',
      model: 'm2',
      trustedPaths: new Set([dir]),
      _embed: async () => {
        throw new Error('network down');
      },
    });
    assert.equal(out.ranker, 'lexical');
  });

  it('propagates a caller abort instead of degrading to lexical', async () => {
    await assert.rejects(
      () =>
        recallMemories({
          memoryDir: dir,
          query: 'alpha',
          apiKey: 'sk-x',
          baseUrl: 'https://x',
          model: 'm2',
          trustedPaths: new Set([dir]),
          _embed: async () => {
            const e = new Error('aborted');
            e.aborted = true;
            throw e;
          },
        }),
      (err) => err.aborted === true,
    );
  });

  it('does not rewrite the sidecar on a pure cache-hit recall', async () => {
    const d2 = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-nowrite-'));
    try {
      await fs.writeFile(path.join(d2, 'x.md'), `---\ndescription: alpha topic\n---\nalpha body`);
      const base = {
        memoryDir: d2,
        apiKey: 'sk-x',
        baseUrl: 'https://x',
        model: 'm1',
        trustedPaths: new Set([d2]),
        _embed: makeEmbed([]),
      };
      await recallMemories({ ...base, query: 'alpha first' });
      const sidecar = path.join(d2, '.embeddings.json');
      const before = (await fs.stat(sidecar)).mtimeMs;
      await new Promise((r) => setTimeout(r, 15));
      await recallMemories({ ...base, query: 'alpha second' });
      const after = (await fs.stat(sidecar)).mtimeMs;
      assert.equal(after, before);
    } finally {
      await fs.rm(d2, { recursive: true, force: true });
    }
  });
});
