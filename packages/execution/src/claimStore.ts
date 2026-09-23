import type { Claim } from '@harness/schemas';
import type { GroundedClaim } from './claimPolicy';

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
  citedFigures?: Claim['citedFigures'];
  singleMetric?: boolean;
  evidenceLinks?: Claim['evidenceLinks'];
  policyId?: string;
  policyFingerprint?: string;
  createdAt: string;
}

/** Complete canonical projection for specialist context, including T2 grounding. */
export function storedClaimToClaim(stored: StoredClaim): Claim {
  return {
    claimId: stored.claimId, statement: stored.statement, confidence: stored.confidence,
    reasoning: stored.reasoning ?? 'Persisted validated claim reasoning is unavailable.',
    evidenceIds: stored.evidenceIds,
    ...(stored.citedFigures !== undefined ? { citedFigures: stored.citedFigures } : {}),
    ...(stored.singleMetric !== undefined ? { singleMetric: stored.singleMetric } : {}),
    ...(stored.evidenceLinks !== undefined ? { evidenceLinks: stored.evidenceLinks } : {}),
    ...(stored.policyId !== undefined ? { policyId: stored.policyId } : {}),
    ...(stored.policyFingerprint !== undefined ? { policyFingerprint: stored.policyFingerprint } : {}),
  };
}

/**
 * Persistensi claim terstruktur (addendum §11/Task 14).
 * Interface murni — implementasi SQLite di packages/database.
 */
export interface ClaimStore {
  save(params: { runId: string; messageId: string; claim: GroundedClaim }): Promise<StoredClaim>;
  /** Only for replaying a validated pre-T2 Judge checkpoint into a missing projection. */
  repairLegacyCheckpointProjection(params: { runId: string; messageId: string; claim: Claim }): Promise<StoredClaim>;
  getByRun(runId: string): Promise<StoredClaim[]>;
}
