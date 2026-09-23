import { describe, expect, it } from 'vitest';
import { ValidationError } from '@harness/shared';
import type { StoredClaim, StoredCounterpoint } from '@harness/execution';
import {
  buildClaimGraph,
  claimGraphIncomingEdges,
  claimGraphOutgoingEdges,
} from '@harness/execution';

const executionId = 'execution-1';

function storedClaim(claimId: string, runId = executionId): StoredClaim {
  return {
    id: `row-${claimId}`,
    runId,
    messageId: null,
    claimId,
    statement: `Historical claim ${claimId} remains readable without grounding metadata.`,
    confidence: 'moderate',
    reasoning: null,
    evidenceIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function storedCounterpoint(
  counterpointId: string,
  targetClaimId: string,
  options: { runId?: string; sourceNodeId?: StoredCounterpoint['sourceNodeId'] } = {},
): StoredCounterpoint {
  return {
    id: `row-${counterpointId}`,
    runId: options.runId ?? executionId,
    messageId: `message-${counterpointId}`,
    counterpointId,
    sourceNodeId: options.sourceNodeId ?? 'round-1-bear-challenge',
    targetClaimId,
    argument: `Counterpoint ${counterpointId} qualifies the target claim.`,
    strength: 'moderate',
    evidenceIds: [],
    evidenceLinks: [],
    policyId: 'counterpoint-policy-v1',
    policyFingerprint: 'fingerprint',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('Claim Graph projection', () => {
  it('rejects blank Execution identities', () => {
    expect(() => buildClaimGraph({ executionId: '', claims: [], counterpoints: [] })).toThrow(ValidationError);
    expect(() => buildClaimGraph({ executionId: '  ', claims: [], counterpoints: [] })).toThrow(ValidationError);
  });

  it('rejects blank canonical Claim and Counterpoint identities', () => {
    expect(() => buildClaimGraph({
      executionId,
      claims: [storedClaim('  ')],
      counterpoints: [],
    })).toThrow(ValidationError);
    expect(() => buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1')],
      counterpoints: [storedCounterpoint('', 'claim-1')],
    })).toThrow(ValidationError);
  });

  it('creates Claim nodes from canonical StoredClaims, including historical rows without T2 metadata', () => {
    const historical = storedClaim('claim-old');
    const graph = buildClaimGraph({ executionId, claims: [historical], counterpoints: [] });

    expect(graph.nodes).toEqual([{ kind: 'claim', executionId, claimId: 'claim-old' }]);
    expect(historical.policyId).toBeUndefined();
    expect(graph.edges).toEqual([]);
  });

  it('creates current Counterpoint nodes and one declared targets edge per Counterpoint', () => {
    const graph = buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1')],
      counterpoints: [storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1')],
    });

    expect(graph.nodes).toEqual([
      { kind: 'claim', executionId, claimId: 'claim-1' },
      { kind: 'counterpoint', executionId, counterpointId: 'counterpoint:round-1-bear-challenge:1' },
    ]);
    expect(graph.edges).toEqual([{
      relation: 'targets',
      from: { kind: 'counterpoint', executionId, counterpointId: 'counterpoint:round-1-bear-challenge:1' },
      to: { kind: 'claim', executionId, claimId: 'claim-1' },
    }]);
  });

  it('preserves distinct Counterpoint identities when several target the same Claim', () => {
    const graph = buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1')],
      counterpoints: [
        storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1'),
        storedCounterpoint('counterpoint:round-1-bear-challenge:2', 'claim-1'),
      ],
    });

    expect(graph.nodes.filter(node => node.kind === 'counterpoint')).toHaveLength(2);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map(edge => edge.from.counterpointId)).toEqual([
      'counterpoint:round-1-bear-challenge:1',
      'counterpoint:round-1-bear-challenge:2',
    ]);
  });

  it('keeps round-one and conditional Counterpoints distinct', () => {
    const graph = buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1')],
      counterpoints: [
        storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1'),
        storedCounterpoint('counterpoint:conditional-bear-rechallenge:1', 'claim-1', {
          sourceNodeId: 'conditional-bear-rechallenge',
        }),
      ],
    });

    expect(graph.nodes.filter(node => node.kind === 'counterpoint').map(node => node.counterpointId)).toEqual([
      'counterpoint:conditional-bear-rechallenge:1',
      'counterpoint:round-1-bear-challenge:1',
    ]);
    expect(graph.edges).toHaveLength(2);
  });

  it('fails closed when a target Claim is absent', () => {
    expect(() => buildClaimGraph({
      executionId,
      claims: [],
      counterpoints: [storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'missing')],
    })).toThrow(/targets missing Claim/);
  });

  it('fails closed when a supplied Claim belongs to another Execution', () => {
    expect(() => buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1', 'execution-2')],
      counterpoints: [],
    })).toThrow(/belongs to Execution/);
  });

  it('fails closed when a supplied Counterpoint belongs to another Execution', () => {
    expect(() => buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1')],
      counterpoints: [storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1', { runId: 'execution-2' })],
    })).toThrow(/belongs to Execution/);
  });

  it('rejects duplicate canonical Claim and Counterpoint identities', () => {
    expect(() => buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1'), storedClaim('claim-1')],
      counterpoints: [],
    })).toThrow(ValidationError);
    expect(() => buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1')],
      counterpoints: [
        storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1'),
        storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1'),
      ],
    })).toThrow(ValidationError);
  });

  it('sorts nodes and edges deterministically and returns immutable output', () => {
    const claims = [storedClaim('claim-b'), storedClaim('claim-a')];
    const counterpoints = [
      storedCounterpoint('counterpoint:round-1-bear-challenge:2', 'claim-b'),
      storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-a'),
    ];
    const graph = buildClaimGraph({ executionId, claims, counterpoints });
    const repeated = buildClaimGraph({
      executionId,
      claims: [...claims].reverse(),
      counterpoints: [...counterpoints].reverse(),
    });

    expect(repeated).toEqual(graph);
    expect(graph.nodes.map(node => node.kind === 'claim' ? node.claimId : node.counterpointId)).toEqual([
      'claim-a', 'claim-b', 'counterpoint:round-1-bear-challenge:1', 'counterpoint:round-1-bear-challenge:2',
    ]);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.edges[0])).toBe(true);
    expect(graph.edges.every(edge => edge.from.executionId === executionId && edge.to.executionId === executionId)).toBe(true);
  });

  it('supports typed incoming and outgoing traversal without inventing rebuttal edges', () => {
    const graph = buildClaimGraph({
      executionId,
      claims: [storedClaim('claim-1'), storedClaim('rebuttal-1')],
      counterpoints: [storedCounterpoint('counterpoint:round-1-bear-challenge:1', 'claim-1')],
    });
    const claimNode = { kind: 'claim', executionId, claimId: 'claim-1' } as const;
    const counterpointNode = {
      kind: 'counterpoint', executionId, counterpointId: 'counterpoint:round-1-bear-challenge:1',
    } as const;

    expect(claimGraphIncomingEdges(graph, claimNode)).toEqual(graph.edges);
    expect(claimGraphOutgoingEdges(graph, counterpointNode)).toEqual(graph.edges);
    expect(claimGraphOutgoingEdges(graph, claimNode)).toEqual([]);
    expect(claimGraphIncomingEdges(graph, counterpointNode)).toEqual([]);
    expect(graph.edges.every(edge => edge.relation === 'targets' && edge.from.kind === 'counterpoint' && edge.to.kind === 'claim')).toBe(true);
  });
});
