import { withRetry, resolveDialect, buildRequestHeaders } from './utils.js';
import { ApiError } from './errors.js';

const EMBED_TIMEOUT = 120_000;

// Cosine similarity over two dense float arrays.
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// POST texts to the OpenRouter-compatible /embeddings endpoint.
// Reuses withRetry (4xx fails fast, 5xx/429 retried). Returns vectors in
// input order plus the raw usage object.
export async function embedTexts(texts, { apiKey, baseUrl, model, signal } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], usage: null };
  }

  const doFetch = async () => {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT);
    try {
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: buildRequestHeaders({ apiKey, dialect: resolveDialect(baseUrl) }),
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(`Embeddings API returned non-JSON (${res.status})`, res.status, text.slice(0, 500));
      }
      if (!res.ok) {
        throw new ApiError(body?.error?.message || `Embeddings API error (${res.status})`, res.status, body);
      }
      return body;
    } catch (err) {
      // Caller aborted — flag it so withRetry fails fast instead of retrying.
      if (signal?.aborted) {
        const aborted = new Error('Embeddings request aborted');
        aborted.aborted = true;
        throw aborted;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };

  const body = await withRetry(doFetch);
  const data = Array.isArray(body?.data) ? body.data : [];
  // Place each embedding at its declared index so a partial/gappy response
  // never misaligns vectors with their inputs. Fall back to positional order
  // only when the response omits indices entirely.
  const hasIndices = data.length > 0 && data.every((d) => Number.isInteger(d?.index));
  let vectors;
  if (hasIndices) {
    const byIndex = new Map(data.map((d) => [d.index, d.embedding]));
    vectors = texts.map((_, i) => byIndex.get(i) ?? null);
  } else {
    vectors = texts.map((_, i) => data[i]?.embedding ?? null);
  }
  return { vectors, usage: body?.usage ?? null };
}
