import { EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import { runEvidence } from './schema';

export type EvidenceMembership = typeof runEvidence.$inferSelect;

/** Shared decoder for persisted Evidence acceptance; EvidencePolicy remains the acceptance authority. */
export function evidenceAcceptanceOf(membership: EvidenceMembership): Evidence['acceptance'] {
  if (membership.policyId === null) {
    if (membership.policyFingerprint !== null || membership.candidateKind !== null || membership.sourceOrigin !== null
      || membership.retrievedAt !== null || membership.acceptedAt !== null || membership.validAt !== null || membership.provenanceJson !== null) {
      throw new Error(`Evidence membership ${membership.runId}/${membership.evidenceId} has partial acceptance metadata`);
    }
    return {
      policyId: 'legacy-v0', policyFingerprint: null, candidateKind: 'legacy', sourceOrigin: null,
      retrievedAt: null, acceptedAt: null, validAt: null, provenance: {}, legacy: true,
    };
  }
  if (membership.policyId !== EVIDENCE_POLICY_ID || membership.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT || membership.candidateKind !== 'financial'
    || !membership.sourceOrigin || !membership.acceptedAt || !membership.provenanceJson) {
    throw new Error(`Evidence membership ${membership.runId}/${membership.evidenceId} is corrupt`);
  }
  const provenance = JSON.parse(membership.provenanceJson) as Record<string, unknown>;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    throw new Error(`Evidence membership ${membership.runId}/${membership.evidenceId} has invalid provenance`);
  }
  return {
    policyId: membership.policyId, policyFingerprint: membership.policyFingerprint, candidateKind: 'financial', sourceOrigin: membership.sourceOrigin,
    retrievedAt: membership.retrievedAt, acceptedAt: membership.acceptedAt,
    validAt: membership.validAt, provenance,
  };
}
