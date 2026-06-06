import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureSafePath } from './utils.js';
import { embedTexts, cosineSimilarity } from './embeddings.js';
import { lexicalRank } from './lexical-rank.js';
import logger from './logger.js';

const SIDECAR_NAME = '.embeddings.json';

// Strip a leading --- frontmatter block; pull the description line out of it.
export function parseMemoryFile(raw) {
  let description = '';
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = raw.slice(fm[0].length);
    const descLine = fm[1].split('\n').find((l) => l.trim().startsWith('description:'));
    if (descLine) {
      description = descLine
        .slice(descLine.indexOf(':') + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    }
  }
  return { description, body: body.trim() };
}

function embedText(description, body) {
  return description ? `${description}\n${body}` : body;
}

function hashText(text, model) {
  return crypto.createHash('sha256').update(`${model}\0${text}`).digest('hex');
}

async function loadCorpus(memoryDir, trustedPaths) {
  let names;
  try {
    names = await fs.readdir(memoryDir);
  } catch {
    return [];
  }
  const corpus = [];
  for (const fname of names) {
    if (!fname.endsWith('.md') || fname === 'MEMORY.md') continue;
    let resolved;
    try {
      resolved = ensureSafePath(path.join(memoryDir, fname), trustedPaths);
    } catch {
      continue;
    }
    let raw;
    try {
      raw = await fs.readFile(resolved, 'utf8');
    } catch {
      continue;
    }
    const { description, body } = parseMemoryFile(raw);
    corpus.push({ name: fname, description, body, text: embedText(description, body) });
  }
  return corpus;
}

function rankLexical(corpus, query, limit) {
  const scores = lexicalRank(
    query,
    corpus.map((c) => c.text),
  );
  const results = corpus
    .map((c, i) => ({ name: c.name, score: scores[i] ?? 0, body: c.body }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { results, usage: null, ranker: 'lexical', total: corpus.length };
}

export async function recallMemories({
  memoryDir,
  query,
  limit = 5,
  apiKey,
  baseUrl,
  model,
  trustedPaths,
  signal,
  _embed = embedTexts,
} = {}) {
  const corpus = await loadCorpus(memoryDir, trustedPaths);
  if (corpus.length === 0) {
    return { results: [], usage: null, ranker: 'lexical', total: 0 };
  }
  return rankLexical(corpus, query, limit);
}
