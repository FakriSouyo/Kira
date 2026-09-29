import type { Evidence } from '@harness/schemas';
import { createFinancialEvidenceCandidate, EVIDENCE_POLICY, type EvidenceStore } from '@harness/evidence';
import {
  verifyFinancialObservation,
  type FinancialDataByKind,
  type FinancialDataResult,
  type FinancialObservationKind,
  type PresentFinancialObservation,
} from '@harness/financial-data';

export type VerifiedFinancialEvidenceResult<K extends FinancialObservationKind> =
  | {
      accepted: true;
      observation: PresentFinancialObservation<K>;
      evidence: Evidence;
    }
  | {
      accepted: false;
      policyId: string;
      reason: string;
    };

export async function verifyAndPersistFinancialEvidence<K extends FinancialObservationKind>(params: {
  executionId: string;
  ticker: string;
  kind: K;
  result: FinancialDataResult<FinancialDataByKind[K]>;
  evidenceStore: Pick<EvidenceStore, 'accept'>;
}): Promise<VerifiedFinancialEvidenceResult<K>> {
  const observation = verifyFinancialObservation(params.kind, params.result, params.ticker);
  const candidate = createFinancialEvidenceCandidate({
    executionId: params.executionId,
    ticker: params.ticker,
    observation,
  });
  const decision = EVIDENCE_POLICY.decide(candidate, new Date().toISOString());
  if (!decision.accepted) {
    return { accepted: false, policyId: decision.policyId, reason: decision.reason };
  }

  const evidence = await params.evidenceStore.accept({
    runId: params.executionId,
    ticker: params.ticker,
    source: decision.source,
    data: decision.data,
    acceptance: decision,
  });
  return {
    accepted: true,
    evidence,
    observation: { ...observation, evidenceIds: [evidence.id] },
  };
}
