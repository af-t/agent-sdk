import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
