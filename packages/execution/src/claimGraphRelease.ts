import { createHash } from 'node:crypto';
import { ARTIFACT_KINDS, type ArtifactKind } from '@harness/schemas';
import { canonicalJson, ValidationError } from '@harness/shared';
import {
  CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  CLAIM_GRAPH_ID,
  CLAIM_GRAPH_VERSION,
  type ClaimGraphEdge,
  type ClaimGraphNodeRef,
} from './claimGraph';

export const CLAIM_GRAPH_RELEASE_RECEIPT_SCHEMA_VERSION = 1 as const;

export interface ClaimGraphArtifactProjection {
  readonly kind: ArtifactKind;
  readonly artifactId: string;
  readonly nodes: readonly ClaimGraphNodeRef[];
  readonly edges: readonly ClaimGraphEdge[];
}

/** Immutable provenance for the published Judge artifact set and its validated graph. */
export interface ClaimGraphReleaseReceipt {
  readonly receiptId: string;
  readonly schemaVersion: typeof CLAIM_GRAPH_RELEASE_RECEIPT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly ticker: string;
  readonly releaseContractId: string;
  readonly releaseContractFingerprint: string;
  readonly artifactGraphProjectionVersion: number;
  readonly claimGraphId: string;
  readonly claimGraphVersion: number;
  readonly claimGraphContractFingerprint: string;
  readonly claimGraphFingerprint: string;
  readonly artifactProjections: readonly ClaimGraphArtifactProjection[];
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface ClaimGraphReleaseReceiptInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly ticker: string;
  readonly releaseContractId: string;
  readonly releaseContractFingerprint: string;
  readonly artifactGraphProjectionVersion: number;
  readonly claimGraphId: string;
  readonly claimGraphVersion: number;
  readonly claimGraphContractFingerprint: string;
  readonly claimGraphFingerprint: string;
  readonly artifactProjections: readonly ClaimGraphArtifactProjection[];
  readonly createdAt: string;
}

export interface ClaimGraphReleaseStore {
  save(receipt: ClaimGraphReleaseReceipt): Promise<ClaimGraphReleaseReceipt>;
  getByExecution(executionId: string): Promise<ClaimGraphReleaseReceipt | null>;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new ValidationError(`Claim Graph release receipt requires ${label}`);
}

function nodeKey(node: ClaimGraphNodeRef): string {
  return node.kind === 'claim'
    ? canonicalJson(['claim', node.executionId, node.claimId])
    : canonicalJson(['counterpoint', node.executionId, node.counterpointId]);
}

function edgeKey(edge: ClaimGraphEdge): string {
  return canonicalJson(['targets', edge.from.executionId, edge.from.counterpointId, edge.to.executionId, edge.to.claimId]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertFingerprint(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new ValidationError(`Claim Graph release receipt requires a valid ${label} fingerprint`);
  }
}

function validateProjection(projection: ClaimGraphArtifactProjection, executionId: string): void {
  if (!projection || !ARTIFACT_KINDS.includes(projection.kind) || typeof projection.artifactId !== 'string' || !projection.artifactId.trim()
    || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) {
    throw new ValidationError('Claim Graph release receipt contains an invalid artifact projection');
  }
  const nodes = new Set<string>();
  for (const node of projection.nodes) {
    if (!node || node.executionId !== executionId
      || (node.kind === 'claim' ? typeof node.claimId !== 'string' || !node.claimId.trim()
        : node.kind === 'counterpoint' ? typeof node.counterpointId !== 'string' || !node.counterpointId.trim() : true)) {
      throw new ValidationError(`Claim Graph release projection ${projection.kind} contains an invalid node`);
    }
    const key = nodeKey(node);
    if (nodes.has(key)) throw new ValidationError(`Claim Graph release projection ${projection.kind} contains duplicate nodes`);
    nodes.add(key);
  }
  const edges = new Set<string>();
  for (const edge of projection.edges) {
    if (!edge || edge.relation !== 'targets' || edge.from.kind !== 'counterpoint' || edge.to.kind !== 'claim'
      || edge.from.executionId !== executionId || edge.to.executionId !== executionId
      || !nodes.has(nodeKey(edge.from)) || !nodes.has(nodeKey(edge.to))) {
      throw new ValidationError(`Claim Graph release projection ${projection.kind} contains an invalid edge`);
    }
    const key = edgeKey(edge);
    if (edges.has(key)) throw new ValidationError(`Claim Graph release projection ${projection.kind} contains duplicate edges`);
    edges.add(key);
  }
  if (projection.kind === 'BULL_CASE'
    && (projection.nodes.length === 0 || projection.nodes.some(node => node.kind !== 'claim') || projection.edges.length !== 0)) {
    throw new ValidationError('BULL_CASE graph projection may contain only Claim nodes and no inferred edges');
  }
  if (projection.kind === 'BEAR_CASE') {
    const counterpoints = projection.nodes.filter(node => node.kind === 'counterpoint');
    const representedNodes = new Set<string>();
    for (const edge of projection.edges) {
      representedNodes.add(nodeKey(edge.from));
      representedNodes.add(nodeKey(edge.to));
    }
    if (counterpoints.length === 0 || projection.nodes.some(node => node.kind !== 'claim' && node.kind !== 'counterpoint')
      || projection.edges.length !== counterpoints.length
      || counterpoints.some(node => projection.edges.filter(edge => edge.from.counterpointId === node.counterpointId).length !== 1)
      || representedNodes.size !== nodes.size || [...nodes].some(node => !representedNodes.has(node))) {
      throw new ValidationError('BEAR_CASE graph projection must contain one declared target edge per Counterpoint');
    }
  }
}

function semanticInput(input: ClaimGraphReleaseReceiptInput): object {
  return {
    schemaVersion: CLAIM_GRAPH_RELEASE_RECEIPT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    turnId: input.turnId,
    executionId: input.executionId,
    ticker: input.ticker,
    releaseContractId: input.releaseContractId,
    releaseContractFingerprint: input.releaseContractFingerprint,
    artifactGraphProjectionVersion: input.artifactGraphProjectionVersion,
    claimGraphId: input.claimGraphId,
    claimGraphVersion: input.claimGraphVersion,
    claimGraphContractFingerprint: input.claimGraphContractFingerprint,
    claimGraphFingerprint: input.claimGraphFingerprint,
    artifactProjections: input.artifactProjections,
  };
}

export function claimGraphReleaseReceiptId(executionId: string): string {
  nonEmpty(executionId, 'an Execution identity');
  return `claim-graph-release_${digest({ executionId }).slice(0, 32)}`;
}

/** The receipt timestamp is operational; the fingerprint covers semantic release identity and projections. */
export function claimGraphReleaseReceiptFingerprint(input: ClaimGraphReleaseReceiptInput): string {
  return digest(semanticInput(input));
}

export function createClaimGraphReleaseReceipt(input: ClaimGraphReleaseReceiptInput): ClaimGraphReleaseReceipt {
  for (const [key, value] of Object.entries({
    sessionId: input.sessionId,
    turnId: input.turnId,
    executionId: input.executionId,
    ticker: input.ticker,
    releaseContractId: input.releaseContractId,
    releaseContractFingerprint: input.releaseContractFingerprint,
    claimGraphId: input.claimGraphId,
    claimGraphContractFingerprint: input.claimGraphContractFingerprint,
    claimGraphFingerprint: input.claimGraphFingerprint,
    createdAt: input.createdAt,
  })) nonEmpty(value, key);
  assertFingerprint(input.releaseContractFingerprint, 'release contract');
  assertFingerprint(input.claimGraphContractFingerprint, 'Claim Graph contract');
  assertFingerprint(input.claimGraphFingerprint, 'Claim Graph');
  if (input.claimGraphId !== CLAIM_GRAPH_ID || input.claimGraphVersion !== CLAIM_GRAPH_VERSION
    || input.claimGraphContractFingerprint !== CLAIM_GRAPH_CONTRACT_FINGERPRINT) {
    throw new ValidationError('Claim Graph release receipt pins an unsupported Claim Graph contract');
  }
  if (!Number.isInteger(input.artifactGraphProjectionVersion) || input.artifactGraphProjectionVersion < 1
    || !Number.isInteger(input.claimGraphVersion) || input.claimGraphVersion < 1
    || !Array.isArray(input.artifactProjections) || input.artifactProjections.length !== ARTIFACT_KINDS.length) {
    throw new ValidationError('Claim Graph release receipt has invalid version or artifact projection fields');
  }
  const projections = input.artifactProjections.map((projection, index) => {
    if (projection.kind !== ARTIFACT_KINDS[index]) {
      throw new ValidationError('Claim Graph release receipt artifact projections are not in canonical order');
    }
    validateProjection(projection, input.executionId);
    return Object.freeze({
      kind: projection.kind,
      artifactId: projection.artifactId,
      nodes: Object.freeze(projection.nodes.map((node: ClaimGraphNodeRef) => Object.freeze({ ...node })).sort((left: ClaimGraphNodeRef, right: ClaimGraphNodeRef) => compareText(nodeKey(left), nodeKey(right)))),
      edges: Object.freeze(projection.edges.map((edge: ClaimGraphEdge) => Object.freeze({
        relation: edge.relation,
        from: Object.freeze({ ...edge.from }),
        to: Object.freeze({ ...edge.to }),
      }) as ClaimGraphEdge).sort((left: ClaimGraphEdge, right: ClaimGraphEdge) => compareText(edgeKey(left), edgeKey(right)))),
    });
  });
  const normalized: ClaimGraphReleaseReceiptInput = { ...input, artifactProjections: projections };
  const fingerprint = claimGraphReleaseReceiptFingerprint(normalized);
  return Object.freeze({
    receiptId: claimGraphReleaseReceiptId(input.executionId),
    schemaVersion: CLAIM_GRAPH_RELEASE_RECEIPT_SCHEMA_VERSION,
    ...normalized,
    artifactProjections: Object.freeze(projections),
    fingerprint,
  });
}
