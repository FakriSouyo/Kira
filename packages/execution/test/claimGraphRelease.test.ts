import { describe, expect, it } from 'vitest';
import {
  CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  CLAIM_GRAPH_ID,
  CLAIM_GRAPH_VERSION,
  createClaimGraphReleaseReceipt,
  type ClaimGraphArtifactProjection,
} from '../src';

const executionId = 'execution-t5';
const claimA = { kind: 'claim', executionId, claimId: 'claim-a' } as const;
const claimB = { kind: 'claim', executionId, claimId: 'claim-b' } as const;
const counterpoint = { kind: 'counterpoint', executionId, counterpointId: 'counterpoint:round-1-bear-challenge:1' } as const;
const edge = { relation: 'targets', from: counterpoint, to: claimA } as const;
const projections: ClaimGraphArtifactProjection[] = [
  { kind: 'BULL_CASE', artifactId: `artifact_bull_case_${executionId}`, nodes: [claimA, claimB], edges: [] },
  { kind: 'BEAR_CASE', artifactId: `artifact_bear_case_${executionId}`, nodes: [counterpoint, claimA], edges: [edge] },
  { kind: 'VERDICT', artifactId: `artifact_verdict_${executionId}`, nodes: [claimA, claimB, counterpoint], edges: [edge] },
];

function receiptInput(overrides: Partial<Parameters<typeof createClaimGraphReleaseReceipt>[0]> = {}) {
  return {
    sessionId: 'session-t5',
    turnId: 'turn-t5',
    executionId,
    ticker: 'BBCA',
    releaseContractId: 'judge-release-v1',
    releaseContractFingerprint: 'a'.repeat(64),
    artifactGraphProjectionVersion: 1,
    claimGraphId: CLAIM_GRAPH_ID,
    claimGraphVersion: CLAIM_GRAPH_VERSION,
    claimGraphContractFingerprint: CLAIM_GRAPH_CONTRACT_FINGERPRINT,
    claimGraphFingerprint: 'b'.repeat(64),
    artifactProjections: projections,
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('Claim Graph release receipt contract', () => {
  it('derives stable identity and semantic fingerprint independent of input ordering and repair time', () => {
    const first = createClaimGraphReleaseReceipt(receiptInput());
    const repaired = createClaimGraphReleaseReceipt(receiptInput({
      createdAt: '2026-09-25T00:00:00.000Z',
      artifactProjections: [
        { ...projections[0]!, nodes: [...projections[0]!.nodes].reverse() },
        { ...projections[1]!, nodes: [...projections[1]!.nodes].reverse(), edges: [...projections[1]!.edges].reverse() },
        { ...projections[2]!, nodes: [...projections[2]!.nodes].reverse(), edges: [...projections[2]!.edges].reverse() },
      ],
    }));

    expect(first.receiptId).toBe(repaired.receiptId);
    expect(first.fingerprint).toBe(repaired.fingerprint);
    expect(first.createdAt).not.toBe(repaired.createdAt);
    expect(createClaimGraphReleaseReceipt(receiptInput({ claimGraphFingerprint: 'c'.repeat(64) })).fingerprint)
      .not.toBe(first.fingerprint);
  });

  it('rejects malformed fingerprints and projections with inferred or extraneous relationships', () => {
    expect(() => createClaimGraphReleaseReceipt(receiptInput({ claimGraphFingerprint: 'invalid' }))).toThrow(/fingerprint/);
    expect(() => createClaimGraphReleaseReceipt(receiptInput({
      artifactProjections: [
        projections[0]!,
        { ...projections[1]!, nodes: [...projections[1]!.nodes, claimB] },
        projections[2]!,
      ],
    }))).toThrow(/BEAR_CASE/);
    expect(() => createClaimGraphReleaseReceipt(receiptInput({
      claimGraphId: 'unsupported-graph',
    }))).toThrow(/unsupported Claim Graph contract/);
    expect(() => createClaimGraphReleaseReceipt(receiptInput({
      executionId: 'execution-other',
    }))).toThrow(/invalid node/);
  });
});
