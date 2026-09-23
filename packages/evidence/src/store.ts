import type { Evidence } from '@harness/schemas';
import type { AcceptedEvidenceDecision } from './policy';

/**
 * Interface murni — tanpa tipe Drizzle (addendum §10, locked).
 * Implementasi konkret (EvidenceStoreSqlite) hidup di packages/database.
 */
export interface EvidenceStore {
  accept(params: { runId: string; ticker: string; source: string; data: Record<string, unknown>; acceptance: AcceptedEvidenceDecision }): Promise<Evidence>;

  /** Global content lookup retained for search and historical callers. */
  getManyByIds(ids: string[]): Promise<Evidence[]>;
  /** Membership-authoritative view; returned runId is the accepting Execution. */
  getManyByIdsForRun(runId: string, ids: string[]): Promise<Evidence[]>;

  /** Query untuk debugging/UI. */
  getByTicker(ticker: string): Promise<Evidence[]>;

  /** Query untuk audit trail. */
  getByRun(runId: string): Promise<Evidence[]>;
}
