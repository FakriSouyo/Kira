import { createHash } from 'node:crypto';
import { canonicalJson, ValidationError } from '@harness/shared';
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

export const CLAIM_GRAPH_VERSION = 1 as const;
export const CLAIM_GRAPH_ID = 'claim-graph-v1' as const;

/** Static semantic description pinned by durable Judge release authority. */
export const CLAIM_GRAPH_CONTRACT = Object.freeze({
  id: CLAIM_GRAPH_ID,
  version: CLAIM_GRAPH_VERSION,
  scope: 'execution-local',
  nodeKinds: Object.freeze(['claim', 'counterpoint'] as const),
  relationships: Object.freeze([Object.freeze({
    relation: 'targets',
    from: 'counterpoint',
    to: 'claim',
    authority: 'Counterpoint.targetClaimId',
  })]),
  nodeAuthorities: Object.freeze({ claim: 'ClaimStore', counterpoint: 'CounterpointStore' }),
} as const);

export const CLAIM_GRAPH_CONTRACT_FINGERPRINT = createHash('sha256')
  .update(canonicalJson(CLAIM_GRAPH_CONTRACT), 'utf8')
  .digest('hex');

function compareGraphNodes(left: ClaimGraphNodeRef, right: ClaimGraphNodeRef): number {
  const kind = compareText(left.kind, right.kind);
  if (kind !== 0) return kind;
  if (left.executionId !== right.executionId) return compareText(left.executionId, right.executionId);
  return left.kind === 'claim' && right.kind === 'claim'
    ? compareText(left.claimId, right.claimId)
    : left.kind === 'counterpoint' && right.kind === 'counterpoint'
      ? compareText(left.counterpointId, right.counterpointId)
      : 0;
}

function compareGraphEdges(left: ClaimGraphEdge, right: ClaimGraphEdge): number {
  return compareText(left.relation, right.relation)
    || compareText(left.from.executionId, right.from.executionId)
    || compareText(left.from.counterpointId, right.from.counterpointId)
    || compareText(left.to.executionId, right.to.executionId)
    || compareText(left.to.claimId, right.to.claimId);
}

/** Fingerprints the canonical execution-local graph independently of input array order. */
export function claimGraphFingerprint(graph: ClaimGraph): string {
  if (!graph.executionId.trim() || graph.nodes.some(node => node.executionId !== graph.executionId)
    || graph.edges.some(edge => edge.from.executionId !== graph.executionId || edge.to.executionId !== graph.executionId)) {
    throw new ValidationError('Claim Graph fingerprint requires one execution-local graph');
  }
  const nodes = graph.nodes.map(node => node.kind === 'claim'
    ? { kind: 'claim' as const, executionId: node.executionId, claimId: node.claimId }
    : { kind: 'counterpoint' as const, executionId: node.executionId, counterpointId: node.counterpointId })
    .sort(compareGraphNodes);
  const edges = graph.edges.map(edge => ({
    relation: edge.relation,
    from: { kind: 'counterpoint' as const, executionId: edge.from.executionId, counterpointId: edge.from.counterpointId },
    to: { kind: 'claim' as const, executionId: edge.to.executionId, claimId: edge.to.claimId },
  })).sort(compareGraphEdges);
  return createHash('sha256').update(canonicalJson({
    contractId: CLAIM_GRAPH_ID,
    contractVersion: CLAIM_GRAPH_VERSION,
    contractFingerprint: CLAIM_GRAPH_CONTRACT_FINGERPRINT,
    executionId: graph.executionId,
    nodes,
    edges,
  }), 'utf8').digest('hex');
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
