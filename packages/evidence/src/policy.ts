import { createHash } from 'node:crypto';
import { verifyFinancialObservation, type PresentFinancialObservation } from '@harness/financial-data';
import { DocumentSearchHitSchema, type DocumentSearchHit } from '@harness/schemas';
import { canonicalJson } from '@harness/shared';

export const EVIDENCE_POLICY_VERSION = 1 as const;
export const EVIDENCE_POLICY_ID = `evidence-policy-v${EVIDENCE_POLICY_VERSION}`;
export const EVIDENCE_POLICY_FINGERPRINT = createHash('sha256').update(canonicalJson({
  id: EVIDENCE_POLICY_ID, financial: 'authoritative-verifier', document: 'candidate-only',
  provenance: 'execution-membership-v1',
})).digest('hex');

export interface EvidenceAcceptance {
  policyId: string;
  policyFingerprint: string | null;
  candidateKind: 'financial' | 'document' | 'legacy';
  sourceOrigin: string | null;
  retrievedAt: string | null;
  acceptedAt: string | null;
  validAt: string | null;
  provenance: Record<string, unknown>;
}

export interface FinancialEvidenceCandidate {
  kind: 'financial';
  executionId: string;
  ticker: string;
  observation: PresentFinancialObservation;
  data: unknown;
}

export interface DocumentEvidenceCandidate {
  kind: 'document';
  executionId: string;
  ticker: string;
  hit: DocumentSearchHit;
}

export type EvidenceCandidate = FinancialEvidenceCandidate | DocumentEvidenceCandidate;
export type EvidenceDecision =
  | ({ accepted: true; executionId: string; ticker: string; source: string; data: Record<string, unknown> } & EvidenceAcceptance)
  | { accepted: false; policyId: string; reason: string };
export type AcceptedEvidenceDecision = Extract<EvidenceDecision, { accepted: true }>;
export interface EvidencePolicy {
  version: typeof EVIDENCE_POLICY_VERSION;
  id: typeof EVIDENCE_POLICY_ID;
  fingerprint: string;
  decide(candidate: EvidenceCandidate, acceptedAt: string): EvidenceDecision;
}

/** A candidate is an input to policy, never a persisted Evidence record. */
export function createFinancialEvidenceCandidate(params: { executionId: string; ticker: string; observation: PresentFinancialObservation }): FinancialEvidenceCandidate {
  return { kind: 'financial', ...params, data: params.observation.data };
}

/** S3 search returns this candidate without creating an Execution or Evidence. U supplies orchestration. */
export function createDocumentEvidenceCandidate(params: { executionId: string; ticker: string; hit: DocumentSearchHit }): DocumentEvidenceCandidate {
  const hit = DocumentSearchHitSchema.parse(params.hit);
  if (hit.chunk.documentId !== hit.citation.documentId || hit.chunk.chunkId !== hit.citation.chunkId
    || hit.chunk.contentHash !== hit.citation.contentHash) {
    throw new Error('Document search hit and citation identity disagree');
  }
  return { kind: 'document', ...params, hit };
}

export function decideEvidenceCandidate(candidate: EvidenceCandidate, acceptedAt: string): EvidenceDecision {
  if (!candidate.executionId || !candidate.ticker || !Number.isFinite(Date.parse(acceptedAt))) {
    return { accepted: false, policyId: EVIDENCE_POLICY_ID, reason: 'MISSING_EXECUTION_SCOPE' };
  }
  if (candidate.kind === 'document') {
    return { accepted: false, policyId: EVIDENCE_POLICY_ID, reason: 'DOCUMENT_ACCEPTANCE_REQUIRES_RESEARCH_EXECUTION_VERIFICATION' };
  }
  try {
    const observed = candidate.observation;
    if (observed?.status !== 'PRESENT' || canonicalJson(candidate.data) !== canonicalJson(observed.data)) throw new Error('candidate data mismatch');
    const verified = verifyFinancialObservation(observed.kind, { data: observed.data, metadata: observed.metadata }, candidate.ticker);
    if (canonicalJson(verified.verification) !== canonicalJson(observed.verification)) throw new Error('verification mismatch');
    const sourceType = observed.metadata.origin;
    return {
      accepted: true, policyId: EVIDENCE_POLICY_ID, policyFingerprint: EVIDENCE_POLICY_FINGERPRINT, candidateKind: 'financial',
      executionId: candidate.executionId, ticker: candidate.ticker, source: observed.metadata.source,
      sourceOrigin: sourceType, data: observed.data as unknown as Record<string, unknown>,
      retrievedAt: observed.metadata.fetchedAt, acceptedAt, validAt: null,
      provenance: { metadata: observed.metadata, verification: observed.verification, observationKind: observed.kind },
    };
  } catch {
    return { accepted: false, policyId: EVIDENCE_POLICY_ID, reason: 'FINANCIAL_VERIFICATION_FAILED' };
  }
}

export const EVIDENCE_POLICY: EvidencePolicy = Object.freeze({
  version: EVIDENCE_POLICY_VERSION,
  id: EVIDENCE_POLICY_ID,
  fingerprint: EVIDENCE_POLICY_FINGERPRINT,
  decide: decideEvidenceCandidate,
});
