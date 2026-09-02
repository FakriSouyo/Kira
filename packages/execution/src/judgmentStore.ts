import type { Breakdown, Judgment } from '@harness/schemas';

/** Baris judgment yang tersimpan di DB (camelCase; mapping snake_case di packages/database). */
export interface StoredJudgment {
  id: string;
  runId: string;
  ticker: string;
  score: number;
  stance: 'bullish' | 'bearish' | 'neutral' | null;
  confidence: 'high' | 'moderate' | 'low' | null;
  breakdown: Breakdown;
  summary: string | null;
  createdAt: string;
}

/**
 * Persistensi judgment final (addendum §11/Task 14).
 * Interface murni — implementasi SQLite di packages/database.
 */
export interface JudgmentStore {
  save(params: { runId: string; judgment: Judgment }): Promise<StoredJudgment>;
  getByRun(runId: string): Promise<StoredJudgment | null>;
}
