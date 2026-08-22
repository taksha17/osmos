type Chunk = {
  id: string;
  docName: string;
  text: string;
  tokens: string[];
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function chunkText(docName: string, text: string, maxChunkTokens = 180, overlap = 40): Chunk[] {
  const tokens = tokenize(text);
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < tokens.length) {
    const end = Math.min(start + maxChunkTokens, tokens.length);
    const slice = tokens.slice(start, end).join(' ');
    if (slice.trim()) {
      chunks.push({
        id: `${docName}-${start}-${end}`,
        docName,
        text: slice.trim(),
        tokens: tokens.slice(start, end),
      });
    }
    start += maxChunkTokens - overlap;
    if (end >= tokens.length) break;
  }
  return chunks;
}

function tfidfScore(queryTokens: string[], chunk: Chunk): number {
  const chunkTokens = chunk.tokens;
  if (!chunkTokens.length) return 0;
  const termFreq = new Map<string, number>();
  for (const t of chunkTokens) {
    termFreq.set(t, (termFreq.get(t) || 0) + 1);
  }
  const chunkLen = chunkTokens.length;
  let score = 0;
  for (const q of queryTokens) {
    const tf = termFreq.get(q) || 0;
    if (tf > 0) score += tf / chunkLen;
  }
  return score;
}

export function retrieveChunks(docs: Array<{ name: string; text: string }>, query: string, topK = 4): Array<{ docName: string; text: string }> {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const allChunks: Chunk[] = [];
  for (const doc of docs) {
    const chunks = chunkText(doc.name, doc.text);
    allChunks.push(...chunks);
  }

  const scored = allChunks
    .map((chunk) => ({ chunk, score: tfidfScore(queryTokens, chunk) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((x) => ({ docName: x.chunk.docName, text: x.chunk.text }));
}
