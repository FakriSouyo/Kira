import { eq } from 'drizzle-orm';
import { ArtifactEnvelopeSchema } from '@harness/schemas';
import {
  buildClaimGraph,
  claimGraphFingerprint,
  claimGraphReleaseReceiptId,
  createClaimGraphReleaseReceipt,
  type ClaimGraphReleaseReceipt,
  type ClaimGraphReleaseReceiptInput,
  type ClaimGraphReleaseStore,
} from '@harness/execution';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { toStoredClaim } from './claimStoreSqlite';
import { toStoredCounterpoint } from './counterpointStoreSqlite';
import {
  artifacts,
  claims as claimRows,
  claimGraphReleaseReceipts,
  counterpoints as counterpointRows,
  executions,
  researchSessions,
  researchTurns,
} from './schema';

type ReceiptRow = typeof claimGraphReleaseReceipts.$inferSelect;

const RECEIPT_KEYS = [
  'receiptId', 'schemaVersion', 'sessionId', 'turnId', 'executionId', 'ticker',
  'releaseContractId', 'releaseContractFingerprint', 'artifactGraphProjectionVersion',
  'claimGraphId', 'claimGraphVersion', 'claimGraphContractFingerprint', 'claimGraphFingerprint',
  'artifactProjections', 'fingerprint', 'createdAt',
].sort();

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Claim Graph release receipt has invalid ${label}`);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Claim Graph release receipt has unexpected ${label} fields`);
  }
}

function assertSameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (actual.length !== actualSet.size || expected.length !== expectedSet.size
    || actualSet.size !== expectedSet.size || [...expectedSet].some(value => !actualSet.has(value))) {
    throw new Error(`Claim Graph release receipt ${label} does not match its artifact or canonical authority`);
  }
}

function assertReceiptShape(value: unknown): asserts value is ClaimGraphReleaseReceipt {
  assertRecord(value, 'payload');
  assertExactKeys(value, RECEIPT_KEYS, 'payload');
  if (!Array.isArray(value.artifactProjections)) throw new Error('Claim Graph release receipt has invalid artifact projections');
  for (const projection of value.artifactProjections) {
    assertRecord(projection, 'artifact projection');
    assertExactKeys(projection, ['artifactId', 'edges', 'kind', 'nodes'], 'artifact projection');
    if (!Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) throw new Error('Claim Graph release receipt has invalid graph references');
    for (const node of projection.nodes) {
      assertRecord(node, 'node reference');
      assertExactKeys(node, node.kind === 'claim'
        ? ['claimId', 'executionId', 'kind']
        : ['counterpointId', 'executionId', 'kind'], 'node reference');
    }
    for (const edge of projection.edges) {
      assertRecord(edge, 'edge');
      assertExactKeys(edge, ['from', 'relation', 'to'], 'edge');
      assertRecord(edge.from, 'edge source');
      assertExactKeys(edge.from, ['counterpointId', 'executionId', 'kind'], 'edge source');
      assertRecord(edge.to, 'edge target');
      assertExactKeys(edge.to, ['claimId', 'executionId', 'kind'], 'edge target');
    }
  }
}

function toReceipt(row: ReceiptRow): ClaimGraphReleaseReceipt {
  let payload: unknown;
  try { payload = JSON.parse(row.payloadJson) as unknown; }
  catch { throw new Error(`Claim Graph release receipt ${row.receiptId} has invalid JSON`); }
  assertReceiptShape(payload);
  const { receiptId, schemaVersion, fingerprint, ...input } = payload;
  if (schemaVersion !== 1 || typeof receiptId !== 'string' || typeof fingerprint !== 'string') {
    throw new Error(`Claim Graph release receipt ${row.receiptId} has invalid identity fields`);
  }
  const receipt = createClaimGraphReleaseReceipt(input as ClaimGraphReleaseReceiptInput);
  if (receiptId !== receipt.receiptId || receiptId !== claimGraphReleaseReceiptId(row.executionId)
    || fingerprint !== receipt.fingerprint
    || row.receiptId !== receipt.receiptId || row.schemaVersion !== receipt.schemaVersion
    || row.sessionId !== receipt.sessionId || row.turnId !== receipt.turnId
    || row.executionId !== receipt.executionId || row.ticker !== receipt.ticker
    || row.fingerprint !== receipt.fingerprint || row.createdAt !== receipt.createdAt) {
    throw new Error(`Claim Graph release receipt ${row.receiptId} failed identity or fingerprint validation`);
  }
  return receipt;
}

function assertLifecycleAndArtifacts(db: Orm, receipt: ClaimGraphReleaseReceipt): void {
  const execution = db.select().from(executions).where(eq(executions.id, receipt.executionId)).limit(1).get();
  if (!execution) throw new Error(`Claim Graph release receipt ${receipt.receiptId} execution not found`);
  if (execution.command !== 'judge' || execution.status !== 'completed') {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} requires a completed Judge execution`);
  }
  if (execution.sessionId !== receipt.sessionId || execution.turnId !== receipt.turnId || execution.ticker !== receipt.ticker) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} lifecycle identity does not match its Execution`);
  }
  if (!execution.completedAt || receipt.createdAt !== execution.completedAt) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} timestamp does not match completed Execution`);
  }
  const [storedClaims, storedCounterpoints] = [
    db.select().from(claimRows).where(eq(claimRows.runId, receipt.executionId)).all(),
    db.select().from(counterpointRows).where(eq(counterpointRows.runId, receipt.executionId)).all(),
  ];
  const graph = buildClaimGraph({
    executionId: receipt.executionId,
    claims: storedClaims.map(toStoredClaim),
    counterpoints: storedCounterpoints.map(toStoredCounterpoint),
  });
  if (claimGraphFingerprint(graph) !== receipt.claimGraphFingerprint) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} does not match canonical Claim and Counterpoint rows`);
  }
  const verdictProjection = receipt.artifactProjections.find(projection => projection.kind === 'VERDICT');
  if (!verdictProjection
    || verdictProjection.nodes.length !== graph.nodes.length
    || verdictProjection.nodes.some(node => !graph.nodes.some(candidate => canonicalJson(candidate) === canonicalJson(node)))
    || verdictProjection.edges.length !== graph.edges.length
    || verdictProjection.edges.some(edge => !graph.edges.some(candidate => canonicalJson(candidate) === canonicalJson(edge)))) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} VERDICT projection does not contain the full canonical graph`);
  }
  const session = db.select({ id: researchSessions.id }).from(researchSessions)
    .where(eq(researchSessions.id, receipt.sessionId)).limit(1).get();
  const turn = db.select().from(researchTurns).where(eq(researchTurns.id, receipt.turnId)).limit(1).get();
  if (!session || !turn || turn.sessionId !== receipt.sessionId) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} has invalid lifecycle references`);
  }

  const seenArtifacts = new Set<string>();
  const parsedArtifacts = new Map<string, ReturnType<typeof ArtifactEnvelopeSchema.parse>>();
  for (const projection of receipt.artifactProjections) {
    if (seenArtifacts.has(projection.artifactId)) throw new Error(`Claim Graph release receipt ${receipt.receiptId} duplicates an Artifact reference`);
    seenArtifacts.add(projection.artifactId);
    const row = db.select().from(artifacts).where(eq(artifacts.artifactId, projection.artifactId)).limit(1).get();
    if (!row) throw new Error(`Claim Graph release receipt ${receipt.receiptId} references missing Artifact ${projection.artifactId}`);
    const artifact = ArtifactEnvelopeSchema.parse({
      artifactId: row.artifactId,
      kind: row.kind,
      schemaVersion: row.schemaVersion,
      sessionId: row.sessionId,
      turnId: row.turnId,
      executionId: row.executionId,
      ticker: row.ticker,
      payload: JSON.parse(row.payloadJson) as unknown,
      createdAt: row.createdAt,
    });
    parsedArtifacts.set(artifact.kind, artifact);
    if (artifact.kind !== projection.kind || artifact.schemaVersion !== 1
      || artifact.executionId !== receipt.executionId || artifact.sessionId !== receipt.sessionId
      || artifact.turnId !== receipt.turnId || artifact.ticker !== receipt.ticker) {
      throw new Error(`Claim Graph release receipt ${receipt.receiptId} Artifact ${projection.artifactId} does not match its projection`);
    }
  }
  const executionArtifacts = db.select().from(artifacts).where(eq(artifacts.executionId, receipt.executionId)).all();
  if (executionArtifacts.length !== receipt.artifactProjections.length) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} does not reference the complete Artifact set`);
  }
  for (const artifact of executionArtifacts) {
    if (!receipt.artifactProjections.some(projection => projection.artifactId === artifact.artifactId && projection.kind === artifact.kind)) {
      throw new Error(`Claim Graph release receipt ${receipt.receiptId} omits Artifact ${artifact.artifactId}`);
    }
  }

  const bullProjection = receipt.artifactProjections.find(projection => projection.kind === 'BULL_CASE')!;
  const bullArtifact = parsedArtifacts.get('BULL_CASE')!;
  const bullPayload = bullArtifact.payload as unknown as {
    thesis: { claims: Array<{ claimId: string }> };
    rebuttal: { claims: Array<{ claimId: string }> };
  };
  assertSameSet(bullProjection.nodes.map(node => node.kind === 'claim' ? node.claimId : `counterpoint:${node.counterpointId}`), [
    ...bullPayload.thesis.claims.map(claim => claim.claimId),
    ...bullPayload.rebuttal.claims.map(claim => claim.claimId),
  ], 'BULL_CASE Claim nodes');

  const bearProjection = receipt.artifactProjections.find(projection => projection.kind === 'BEAR_CASE')!;
  const bearArtifact = parsedArtifacts.get('BEAR_CASE')!;
  const bearPayload = bearArtifact.payload as unknown as { counterpoints: Array<{ counterpointId: string; targetClaimId: string }> };
  const roundOneCounterpoints = storedCounterpoints.filter(point => point.sourceNodeId === 'round-1-bear-challenge');
  assertSameSet(bearPayload.counterpoints.map(point => point.counterpointId), roundOneCounterpoints.map(point => point.counterpointId), 'BEAR_CASE Counterpoints');
  if (bearProjection.edges.length !== roundOneCounterpoints.length
    || roundOneCounterpoints.some(point => !bearProjection.edges.some(edge => edge.from.counterpointId === point.counterpointId && edge.to.claimId === point.targetClaimId))) {
    throw new Error(`Claim Graph release receipt ${receipt.receiptId} BEAR_CASE targets do not match Counterpoint authorities`);
  }
  const expectedBearNodes = new Set<string>();
  for (const point of roundOneCounterpoints) {
    expectedBearNodes.add(canonicalJson({ kind: 'counterpoint', executionId: receipt.executionId, counterpointId: point.counterpointId }));
    expectedBearNodes.add(canonicalJson({ kind: 'claim', executionId: receipt.executionId, claimId: point.targetClaimId }));
  }
  assertSameSet(bearProjection.nodes.map(node => canonicalJson(node)), [...expectedBearNodes], 'BEAR_CASE graph nodes');

  const verdictArtifact = parsedArtifacts.get('VERDICT')!;
  const verdictPayload = verdictArtifact.payload as unknown as { claimIds: string[] };
  assertSameSet(verdictPayload.claimIds, storedClaims.map(claim => claim.claimId), 'VERDICT Claim IDs');
}

/** Insert-only persistence with full receipt, lifecycle, and artifact-reference validation. */
export class ClaimGraphReleaseStoreSqlite implements ClaimGraphReleaseStore {
  constructor(private readonly db: Orm) {}

  async save(input: ClaimGraphReleaseReceipt): Promise<ClaimGraphReleaseReceipt> {
    assertReceiptShape(input);
    const { receiptId, schemaVersion, fingerprint, ...receiptInput } = input;
    const receipt = createClaimGraphReleaseReceipt(receiptInput as ClaimGraphReleaseReceiptInput);
    if (schemaVersion !== receipt.schemaVersion || receiptId !== receipt.receiptId || fingerprint !== receipt.fingerprint) {
      throw new Error(`Claim Graph release receipt ${receiptId} has an invalid identity`);
    }
    return this.db.transaction(tx => {
      assertLifecycleAndArtifacts(tx, receipt);
      const byExecution = tx.select().from(claimGraphReleaseReceipts)
        .where(eq(claimGraphReleaseReceipts.executionId, receipt.executionId)).limit(1).get();
      const byId = tx.select().from(claimGraphReleaseReceipts)
        .where(eq(claimGraphReleaseReceipts.receiptId, receipt.receiptId)).limit(1).get();
      const existing = byExecution ?? byId;
      if (existing) {
        const stored = toReceipt(existing as ReceiptRow);
        assertLifecycleAndArtifacts(tx, stored);
        if (stored.receiptId !== receipt.receiptId || stored.executionId !== receipt.executionId
          || stored.fingerprint !== receipt.fingerprint) {
          throw new Error(`Claim Graph release receipt ${receipt.executionId} is immutable and conflicts with the existing record`);
        }
        return stored;
      }
      tx.insert(claimGraphReleaseReceipts).values({
        receiptId: receipt.receiptId,
        schemaVersion: receipt.schemaVersion,
        sessionId: receipt.sessionId,
        turnId: receipt.turnId,
        executionId: receipt.executionId,
        ticker: receipt.ticker,
        payloadJson: canonicalJson(receipt),
        fingerprint: receipt.fingerprint,
        createdAt: receipt.createdAt,
      }).run();
      const inserted = tx.select().from(claimGraphReleaseReceipts)
        .where(eq(claimGraphReleaseReceipts.receiptId, receipt.receiptId)).limit(1).get();
      if (!inserted) throw new Error(`Claim Graph release receipt ${receipt.receiptId} was not persisted`);
      const saved = toReceipt(inserted as ReceiptRow);
      assertLifecycleAndArtifacts(tx, saved);
      return saved;
    });
  }

  async getByExecution(executionId: string): Promise<ClaimGraphReleaseReceipt | null> {
    const row = this.db.select().from(claimGraphReleaseReceipts)
      .where(eq(claimGraphReleaseReceipts.executionId, executionId))
      .limit(1).get();
    if (!row) return null;
    const receipt = toReceipt(row as ReceiptRow);
    assertLifecycleAndArtifacts(this.db, receipt);
    return receipt;
  }
}
