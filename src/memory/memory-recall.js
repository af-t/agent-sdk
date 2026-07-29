import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSafePath } from '../support/path-safety.js';
import { resolveLogger } from '../support/logger.js';
import { embedTexts, cosineSimilarity } from './embeddings.js';
import { lexicalRank } from './lexical-rank.js';

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

async function readSidecar(sidecarPath, logger) {
  try {
    const parsed = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.entries) return parsed.entries;
  } catch (err) {
    // missing or corrupt: treat as empty
    logger.debug({ error: err, sidecarPath }, 'Sidecar read failed; treating cache as empty');
  }
  return {};
}

async function writeSidecar(sidecarPath, entries, logger) {
  try {
    await fs.writeFile(sidecarPath, JSON.stringify({ entries }), 'utf8');
  } catch (err) {
    logger.debug({ error: err, sidecarPath }, 'Sidecar write failed');
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
  restricted = true,
  signal,
  logger,
  _embed,
}) {
  let sidecarPath;
  try {
    sidecarPath = resolveSafePath(path.join(memoryDir, SIDECAR_NAME), trustedPaths, { restricted });
  } catch {
    sidecarPath = null;
  }
  const cached = sidecarPath ? await readSidecar(sidecarPath, logger) : {};

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
  // Only rewrite the sidecar when something actually changed (new/edited file
  // embedded, or a deleted file pruned): a pure cache-hit recall touches nothing.
  const changed = toEmbed.length > 0 || Object.keys(nextEntries).length !== Object.keys(cached).length;
  if (sidecarPath && changed) await writeSidecar(sidecarPath, nextEntries, logger);

  const results = corpus
    .map((c) => ({ name: c.name, score: c.vector ? cosineSimilarity(queryVec, c.vector) : 0, body: c.body }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return { results, usage, ranker: 'embeddings', total: corpus.length };
}

async function loadCorpus(memoryDir, trustedPaths, restricted = true, logger) {
  let names;
  try {
    names = await fs.readdir(memoryDir);
  } catch (err) {
    logger.debug({ error: err, memoryDir }, 'Failed to read memory directory');
    return [];
  }
  const corpus = [];
  for (const fname of names) {
    if (!fname.endsWith('.md') || fname === 'MEMORY.md') continue;
    let resolved;
    try {
      resolved = resolveSafePath(path.join(memoryDir, fname), trustedPaths, { restricted });
    } catch (err) {
      logger.debug({ error: err, fileName: fname }, 'Memory file path check failed');
      continue;
    }
    let raw;
    try {
      raw = await fs.readFile(resolved, 'utf8');
    } catch (err) {
      logger.debug({ error: err, filePath: resolved }, 'Failed to read memory file');
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
  restricted = true,
  signal,
  logger,
  _embed = embedTexts,
} = {}) {
  const componentLogger = resolveLogger(logger).child({ component: 'memoryRecall' });
  const corpus = await loadCorpus(memoryDir, trustedPaths, restricted, componentLogger);
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
        restricted,
        signal,
        logger: componentLogger,
        _embed,
      });
    } catch (err) {
      // A caller-initiated abort should propagate, not silently degrade to lexical.
      if (signal?.aborted || err?.aborted) throw err;
      componentLogger.debug({ error: err }, 'Embeddings ranking failed; falling back to lexical');
    }
  }
  return rankLexical(corpus, query, limit);
}
