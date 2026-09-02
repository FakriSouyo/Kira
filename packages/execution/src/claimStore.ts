import type { Claim } from '@harness/schemas';

/** Baris claim yang tersimpan di DB (camelCase; mapping snake_case di packages/database). */
export interface StoredClaim {
  id: string;
  runId: string;
  messageId: string | null;
  claimId: string;
  statement: string;
  confidence: 'strong' | 'moderate' | 'weak';
  reasoning: string | null;
  evidenceIds: string[];
  createdAt: string;
}

/**
 * Persistensi claim terstruktur (addendum §11/Task 14).
 * Interface murni — implementasi SQLite di packages/database.
 */
export interface ClaimStore {
  save(params: { runId: string; messageId: string; claim: Claim }): Promise<StoredClaim>;
  getByRun(runId: string): Promise<StoredClaim[]>;
}
