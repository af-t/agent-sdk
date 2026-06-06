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

async function readSidecar(sidecarPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.entries) return parsed.entries;
  } catch {
    // missing or corrupt — treat as empty
  }
  return {};
}

async function writeSidecar(sidecarPath, entries) {
  try {
    await fs.writeFile(sidecarPath, JSON.stringify({ entries }), 'utf8');
  } catch (err) {
    logger.debug(`memory-recall: sidecar write failed: ${err.message}`);
  }
}

async function rankWithEmbeddings({
  corpus,
  memoryDir,
  query,
  limit,
  apiKey,
  baseUrl,
  model,
  trustedPaths,
  signal,
  _embed,
}) {
  let sidecarPath = null;
  try {
    sidecarPath = ensureSafePath(path.join(memoryDir, SIDECAR_NAME), trustedPaths);
  } catch {
    sidecarPath = null;
  }
  const cached = sidecarPath ? await readSidecar(sidecarPath) : {};

  const toEmbed = [];
  for (const c of corpus) {
    c.hash = hashText(c.text, model);
    const entry = cached[c.name];
    if (entry && entry.hash === c.hash && Array.isArray(entry.vector)) {
      c.vector = entry.vector;
    } else {
      toEmbed.push(c);
    }
  }

  const inputs = [query, ...toEmbed.map((c) => c.text)];
  const { vectors, usage } = await _embed(inputs, { apiKey, baseUrl, model, signal });
  const queryVec = vectors[0];
  toEmbed.forEach((c, i) => {
    c.vector = vectors[i + 1];
  });

  const nextEntries = {};
  for (const c of corpus) {
    if (Array.isArray(c.vector)) nextEntries[c.name] = { hash: c.hash, vector: c.vector };
  }
  if (sidecarPath) await writeSidecar(sidecarPath, nextEntries);

  const results = corpus
    .map((c) => ({ name: c.name, score: c.vector ? cosineSimilarity(queryVec, c.vector) : 0, body: c.body }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { results, usage, ranker: 'embeddings', total: corpus.length };
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
  if (apiKey) {
    try {
      return await rankWithEmbeddings({
        corpus,
        memoryDir,
        query,
        limit,
        apiKey,
        baseUrl,
        model,
        trustedPaths,
        signal,
        _embed,
      });
    } catch (err) {
      logger.debug(`memory-recall: embeddings path failed, using lexical: ${err.message}`);
    }
  }
  return rankLexical(corpus, query, limit);
}
