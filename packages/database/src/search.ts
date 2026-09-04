import type { Evidence } from '@harness/schemas';
import { cosineSimilarity, mockEmbedding } from '@harness/shared';
import type { FinharnessDatabase } from './client';

/**
 * Search evidence (Phase 7 Future prototype, placeholder pgvector).
 * Scoring: keywordOverlap (primary) + cosineSimilarity(mockEmbedding) tie-break.
 * Read-only, tanpa migrasi baru.
 */
export async function searchEvidence(
  db: FinharnessDatabase,
  params: { runId?: string; query: string; limit?: number },
): Promise<Array<Evidence & { _score: number }>> {
  const { runId, query, limit = 5 } = params;
  let evidences: Evidence[] = [];
  if (runId) {
    evidences = await db.evidence.getByRun(runId);
  } else {
    const runs = await db.execution.listRuns({ limit: 1 });
    if (runs.length === 0) return [];
    evidences = await db.evidence.getByRun(runs[0].id);
  }
  if (evidences.length === 0) return [];
  const qTokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const qVec = mockEmbedding(query);
  const scored = evidences.map((ev) => {
    const text = JSON.stringify(ev.data).toLowerCase();
    const overlap = qTokens.reduce((c, t) => c + (text.includes(t) ? 1 : 0), 0);
    const evVec = mockEmbedding(text.slice(0, 200));
    const cos = cosineSimilarity(qVec, evVec);
    // primary overlap, cosine as tie (0.01 weight)
    const score = overlap + cos * 0.01;
    return { ...ev, _score: score, _overlap: overlap };
  });
  scored.sort((a, b) => (b as unknown as { _score: number })._score - (a as unknown as { _score: number })._score);
  return scored.slice(0, Math.min(limit, 20)) as Array<Evidence & { _score: number }>;
}
