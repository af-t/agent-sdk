function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function sparseCosine(a, b) {
  let dot = 0;
  for (const [t, va] of a) {
    const vb = b.get(t);
    if (vb) dot += va * vb;
  }
  let normA = 0;
  for (const v of a.values()) normA += v * v;
  let normB = 0;
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// TF-IDF cosine of a query against each document. Returns one score per
// document, in document order. Zero-dependency, deterministic.
export function lexicalRank(query, documents) {
  const docs = documents.map(tokenize);
  const N = docs.length;
  if (N === 0) return [];

  const df = new Map();
  for (const tokens of docs) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const tfidf = (tokens) => {
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    const vec = new Map();
    for (const [t, c] of counts) vec.set(t, c * idf(t));
    return vec;
  };

  const queryVec = tfidf(tokenize(query));
  return docs.map((tokens) => sparseCosine(queryVec, tfidf(tokens)));
}
