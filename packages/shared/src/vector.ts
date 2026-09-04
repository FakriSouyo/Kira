/**
 * Vector helpers — mock deterministik (Phase 7 Future prototype).
 * Placeholder untuk pgvector / OpenAI text-embedding-3-small Future.
 * Tanpa network, tanpa API key.
 */

function fnv1a(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mock embedding 8-dim normalized [-1,1] deterministik dari text. */
export function mockEmbedding(text: string, dim = 8): number[] {
  const vec: number[] = [];
  for (let i = 0; i < dim; i++) {
    const h = fnv1a(`${text}:${i}`);
    // map uint32 → [-1,1]
    vec.push((h / 0xffffffff) * 2 - 1);
  }
  // L2 normalize
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

/** Cosine similarity — 1 = identical, 0 = orthogonal, -1 = opposite. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('cosineSimilarity: dim mismatch');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}
