import { ArtifactEnvelopeSchema, type ArtifactEnvelope, type ArtifactKind } from '@harness/schemas';
import type { ArtifactSourceExecution } from '@harness/session-core';
import { type ArtifactValidityReason, type ArtifactValidityResult } from './contracts.js';

export interface ArtifactValidityParams {
  readonly artifact: unknown;
  readonly expectedSession: string;
  readonly expectedSubjects: readonly string[];
  readonly expectedKind?: ArtifactKind;
  readonly sourceExecution?: ArtifactSourceExecution | null;
}

/** Structural/context eligibility only; provider freshness is deliberately out of scope. */
export function evaluateArtifactValidity(params: ArtifactValidityParams): ArtifactValidityResult {
  const parsed = ArtifactEnvelopeSchema.safeParse(params.artifact);
  if (!parsed.success) return { status: 'INVALID', reasons: ['MALFORMED_ARTIFACT'] };
  const artifact = parsed.data;
  const reasons: ArtifactValidityReason[] = ['SCHEMA_VALID'];
  if (artifact.sessionId !== params.expectedSession) return { status: 'INVALID', reasons: [...reasons, 'WRONG_SESSION'] };
  reasons.push('SESSION_MATCH');
  if (params.expectedKind && artifact.kind !== params.expectedKind) return { status: 'INVALID', reasons: [...reasons, 'WRONG_KIND'] };
  if (params.expectedKind) reasons.push('KIND_MATCH');
  if (params.expectedSubjects.length > 0 && !params.expectedSubjects.includes(artifact.ticker)) {
    return { status: 'INVALID', reasons: [...reasons, 'WRONG_SUBJECT'] };
  }
  if (params.expectedSubjects.length > 0) reasons.push('SUBJECT_MATCH');
  if (params.sourceExecution === null) return { status: 'INVALID', reasons: [...reasons, 'MISSING_SOURCE_EXECUTION'] };
  if (params.sourceExecution === undefined) return { status: 'UNKNOWN', reasons: [...reasons, 'MISSING_SOURCE_EXECUTION', 'UNKNOWN_FRESHNESS'] };
  if (params.sourceExecution.sessionId !== artifact.sessionId || params.sourceExecution.turnId !== artifact.turnId) {
    return { status: 'INVALID', reasons: [...reasons, 'WRONG_SESSION', 'DEPENDENCY_MISSING'] };
  }
  if (params.sourceExecution.ticker !== artifact.ticker) {
    return { status: 'INVALID', reasons: [...reasons, 'WRONG_SUBJECT', 'DEPENDENCY_MISSING'] };
  }
  if (params.sourceExecution.command !== 'judge') return { status: 'INVALID', reasons: [...reasons, 'DEPENDENCY_MISSING'] };
  if (params.sourceExecution && params.sourceExecution.status !== 'completed') {
    return { status: 'INVALID', reasons: [...reasons, 'SOURCE_EXECUTION_INCOMPLETE'] };
  }
  if (params.sourceExecution) reasons.push('SOURCE_EXECUTION_COMPLETED');
  reasons.push('UNKNOWN_FRESHNESS');
  return { status: 'VALID_AS_PRIOR', reasons };
}

export function validityForArtifact(artifact: ArtifactEnvelope): ArtifactValidityResult {
  return evaluateArtifactValidity({ artifact, expectedSession: artifact.sessionId, expectedSubjects: [artifact.ticker] });
}
