import { ValidationError } from '@harness/shared';
import type { StoredClaim } from './claimStore';
import type { StoredCounterpoint } from './counterpointStore';

/** Execution-local identity for one canonical Claim or current Counterpoint. */
export type ClaimGraphNodeRef =
  | Readonly<{
      kind: 'claim';
      executionId: string;
      claimId: string;
    }>
  | Readonly<{
      kind: 'counterpoint';
      executionId: string;
      counterpointId: string;
    }>;

export type ClaimGraphClaimNodeRef = Extract<ClaimGraphNodeRef, { kind: 'claim' }>;
export type ClaimGraphCounterpointNodeRef = Extract<ClaimGraphNodeRef, { kind: 'counterpoint' }>;

/** The only relationship currently declared by the durable execution domain. */
export interface ClaimGraphEdge {
  readonly relation: 'targets';
  readonly from: ClaimGraphCounterpointNodeRef;
  readonly to: ClaimGraphClaimNodeRef;
}

/** Deterministic, immutable projection of one Execution's canonical debate rows. */
export interface ClaimGraph {
  readonly executionId: string;
  readonly nodes: readonly ClaimGraphNodeRef[];
  readonly edges: readonly ClaimGraphEdge[];
}

export interface BuildClaimGraphInput {
  readonly executionId: string;
  readonly claims: readonly StoredClaim[];
  readonly counterpoints: readonly StoredCounterpoint[];
}

/** Read port for the deterministic projection of canonical Claim authorities. */
export interface ClaimGraphReader {
  getByExecution(executionId: string): Promise<ClaimGraph>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeNode<T extends ClaimGraphNodeRef>(node: T): T {
  return Object.freeze(node);
}

function sameNode(left: ClaimGraphNodeRef, right: ClaimGraphNodeRef): boolean {
  if (left.kind !== right.kind || left.executionId !== right.executionId) return false;
  return left.kind === 'claim'
    ? right.kind === 'claim' && left.claimId === right.claimId
    : right.kind === 'counterpoint' && left.counterpointId === right.counterpointId;
}

/**
 * Reconstructs a graph from the durable Claim and Counterpoint authorities.
 * Historical Claims remain nodes; only current stored Counterpoints contribute
 * nodes and their declared `targetClaimId` contributes a `targets` edge.
 */
export function buildClaimGraph(input: BuildClaimGraphInput): ClaimGraph {
  const { executionId, claims, counterpoints } = input;
  if (!executionId.trim()) throw new ValidationError('Claim Graph requires an Execution identity');

  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (claim.runId !== executionId) {
      throw new ValidationError(`Claim ${claim.claimId} belongs to Execution ${claim.runId}, not ${executionId}`);
    }
    if (!claim.claimId.trim()) throw new ValidationError(`Execution ${executionId} contains a Claim without an identity`);
    if (claimIds.has(claim.claimId)) {
      throw new ValidationError(`Execution ${executionId} contains duplicate Claim identity ${claim.claimId}`);
    }
    claimIds.add(claim.claimId);
  }

  const counterpointIds = new Set<string>();
  for (const counterpoint of counterpoints) {
    if (counterpoint.runId !== executionId) {
      throw new ValidationError(`Counterpoint ${counterpoint.counterpointId} belongs to Execution ${counterpoint.runId}, not ${executionId}`);
    }
    if (!counterpoint.counterpointId.trim()) {
      throw new ValidationError(`Execution ${executionId} contains a Counterpoint without an identity`);
    }
    if (counterpointIds.has(counterpoint.counterpointId)) {
      throw new ValidationError(`Execution ${executionId} contains duplicate Counterpoint identity ${counterpoint.counterpointId}`);
    }
    counterpointIds.add(counterpoint.counterpointId);
  }

  const claimNodes = claims
    .map(claim => freezeNode({ kind: 'claim' as const, executionId, claimId: claim.claimId }))
    .sort((left, right) => compareText(left.claimId, right.claimId));
  const counterpointNodes = counterpoints
    .map(counterpoint => freezeNode({ kind: 'counterpoint' as const, executionId, counterpointId: counterpoint.counterpointId }))
    .sort((left, right) => compareText(left.counterpointId, right.counterpointId));

  const edgeTuples = new Set<string>();
  const edges = counterpoints.map((counterpoint): ClaimGraphEdge => {
    if (!claimIds.has(counterpoint.targetClaimId)) {
      throw new ValidationError(
        `Counterpoint ${counterpoint.counterpointId} targets missing Claim ${counterpoint.targetClaimId} in Execution ${executionId}`,
      );
    }
    const from = freezeNode({ kind: 'counterpoint' as const, executionId, counterpointId: counterpoint.counterpointId });
    const to = freezeNode({ kind: 'claim' as const, executionId, claimId: counterpoint.targetClaimId });
    if (from.executionId !== to.executionId) {
      throw new ValidationError(`Claim Graph edge ${counterpoint.counterpointId} crosses Execution boundaries`);
    }
    const tuple = JSON.stringify(['targets', from.executionId, from.counterpointId, to.executionId, to.claimId]);
    if (edgeTuples.has(tuple)) throw new ValidationError(`Execution ${executionId} contains a duplicate Claim Graph edge`);
    edgeTuples.add(tuple);
    return Object.freeze({ relation: 'targets', from, to });
  }).sort((left, right) => compareText(left.from.counterpointId, right.from.counterpointId)
    || compareText(left.to.claimId, right.to.claimId));

  return Object.freeze({
    executionId,
    nodes: Object.freeze([...claimNodes, ...counterpointNodes]),
    edges: Object.freeze(edges),
  });
}

/** Returns the declared edges entering a node, preserving canonical edge order. */
export function claimGraphIncomingEdges(graph: ClaimGraph, node: ClaimGraphNodeRef): readonly ClaimGraphEdge[] {
  return Object.freeze(graph.edges.filter(edge => sameNode(edge.to, node)));
}

/** Returns the declared edges leaving a node, preserving canonical edge order. */
export function claimGraphOutgoingEdges(graph: ClaimGraph, node: ClaimGraphNodeRef): readonly ClaimGraphEdge[] {
  return Object.freeze(graph.edges.filter(edge => sameNode(edge.from, node)));
}
