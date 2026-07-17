function tokenize(text) {
  return (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
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
    let normSquared = 0;
    for (const [t, count] of counts) {
      const value = count * idf(t);
      vec.set(t, value);
      normSquared += value * value;
    }
    return { vec, normSquared };
  };

  const queryVector = tfidf(tokenize(query));
  return docs.map((tokens) => {
    const documentVector = tfidf(tokens);
    if (queryVector.normSquared === 0 || documentVector.normSquared === 0) return 0;

    let dot = 0;
    for (const [term, queryValue] of queryVector.vec) {
      const documentValue = documentVector.vec.get(term);
      if (documentValue) dot += queryValue * documentValue;
    }
    return dot / (Math.sqrt(queryVector.normSquared) * Math.sqrt(documentVector.normSquared));
  });
}
