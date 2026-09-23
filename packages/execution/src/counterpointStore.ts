import type { GroundedCounterpoint } from '@harness/schemas';
import { GroundedCounterpointSchema } from '@harness/schemas';
import type { CounterpointSourceNodeId } from './counterpointPolicy';

/** Canonical durable Counterpoint row, mapped from SQLite only in packages/database. */
export interface StoredCounterpoint {
  id: string;
  runId: string;
  messageId: string;
  counterpointId: string;
  sourceNodeId: CounterpointSourceNodeId;
  targetClaimId: string;
  argument: string;
  strength: 'high' | 'moderate' | 'low';
  evidenceIds: string[];
  citedFigures?: GroundedCounterpoint['citedFigures'];
  evidenceLinks: GroundedCounterpoint['evidenceLinks'];
  policyId: string;
  policyFingerprint: string;
  createdAt: string;
}

/** Restores the complete canonical shape consumed by current specialist paths. */
export function storedCounterpointToCounterpoint(stored: StoredCounterpoint): GroundedCounterpoint {
  return GroundedCounterpointSchema.parse({
    counterpointId: stored.counterpointId,
    sourceNodeId: stored.sourceNodeId,
    targetClaimId: stored.targetClaimId,
    argument: stored.argument,
    strength: stored.strength,
    evidenceIds: stored.evidenceIds,
    ...(stored.citedFigures !== undefined ? { citedFigures: stored.citedFigures } : {}),
    evidenceLinks: stored.evidenceLinks,
    policyId: stored.policyId,
    policyFingerprint: stored.policyFingerprint,
  });
}

/** Pure execution-domain authority for current grounded Counterpoints. */
export interface CounterpointStore {
  save(params: { runId: string; messageId: string; counterpoint: GroundedCounterpoint }): Promise<StoredCounterpoint>;
  getByRun(runId: string): Promise<StoredCounterpoint[]>;
}
