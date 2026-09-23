import { createHash } from 'node:crypto';
import { ARTIFACT_KINDS } from '@harness/schemas';
import {
  CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  CLAIM_GRAPH_ID,
  CLAIM_GRAPH_VERSION,
  CLAIM_POLICY_FINGERPRINT,
  CLAIM_POLICY_ID,
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
} from '@harness/execution';
import { canonicalJson } from '@harness/shared';

export const JUDGE_RELEASE_CONTRACT_VERSION = 1 as const;
export const JUDGE_RELEASE_CONTRACT_ID = 'judge-release-v1' as const;

/** Canonical semantic release authority for new lifecycle Judge executions. */
export const JUDGE_RELEASE_CONTRACT = Object.freeze({
  id: JUDGE_RELEASE_CONTRACT_ID,
  version: JUDGE_RELEASE_CONTRACT_VERSION,
  claimPolicy: Object.freeze({ id: CLAIM_POLICY_ID, fingerprint: CLAIM_POLICY_FINGERPRINT }),
  counterpointPolicy: Object.freeze({ id: COUNTERPOINT_POLICY_ID, fingerprint: COUNTERPOINT_POLICY_FINGERPRINT }),
  claimGraph: Object.freeze({
    id: CLAIM_GRAPH_ID,
    version: CLAIM_GRAPH_VERSION,
    fingerprint: CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  }),
  artifacts: Object.freeze({ kinds: Object.freeze([...ARTIFACT_KINDS]), schemaVersion: 1 }),
  artifactGraphProjectionVersion: 1,
} as const);

export type JudgeReleaseContract = typeof JUDGE_RELEASE_CONTRACT;

export const JUDGE_RELEASE_CONTRACT_FINGERPRINT = createHash('sha256')
  .update(canonicalJson(JUDGE_RELEASE_CONTRACT), 'utf8')
  .digest('hex');

export type JudgeReleaseProfileKind = 'legacy' | 'current';

/** Classifies old profiles without upgrading them and validates both current markers atomically. */
export function classifyJudgeReleaseProfilePayload(payload: unknown): JudgeReleaseProfileKind {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('Judge execution profile payload is not an object');
  }
  const value = payload as Record<string, unknown>;
  const hasContract = value.releaseContract !== undefined;
  const hasFingerprint = value.releaseContractFingerprint !== undefined;
  if (!hasContract && !hasFingerprint) return 'legacy';
  if (!hasContract || !hasFingerprint) {
    throw new Error('Judge execution profile has incomplete release contract markers');
  }
  if (typeof value.releaseContractFingerprint !== 'string'
    || value.releaseContractFingerprint !== JUDGE_RELEASE_CONTRACT_FINGERPRINT
    || canonicalJson(value.releaseContract) !== canonicalJson(JUDGE_RELEASE_CONTRACT)) {
    throw new Error('Judge execution profile pins an unsupported release contract');
  }
  return 'current';
}
