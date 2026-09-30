import { and, eq, inArray } from 'drizzle-orm';
import {
  ARTIFACT_PRODUCER_BY_KIND,
  ArtifactEnvelopeSchema,
  ComparisonReportPayloadSchema,
  type ComparisonReportPayload,
} from '@harness/schemas';
import type {
  ComparisonReportPublication,
  ComparisonReportPublicationStore,
  ComparisonReportArtifact,
  ResearchExecution,
} from '@harness/session-core';
import { EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID } from '@harness/evidence';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { evidenceAcceptanceOf } from './evidenceMembership';
import { artifacts, evidence, executions, researchSessions, researchTurns, runEvidence } from './schema';

type ArtifactRow = typeof artifacts.$inferSelect;
type ExecutionRow = typeof executions.$inferSelect;
type Transaction = Parameters<Parameters<Orm['transaction']>[0]>[0];

function toExecution(row: ExecutionRow): ResearchExecution {
  if (row.sessionId === null || row.turnId === null || row.attempt === null) {
    throw new Error(`Execution ${row.id} is not linked to the canonical session lifecycle`);
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    attempt: row.attempt,
    ticker: row.ticker,
    command: row.command,
    status: row.status as ResearchExecution['status'],
    executionTime: row.executionTime,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    resumeGeneration: row.resumeGeneration,
  };
}

function toComparisonReport(row: ArtifactRow): ComparisonReportArtifact {
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
  if (artifact.kind !== 'COMPARISON_REPORT') throw new Error(`Artifact ${row.artifactId} is not a Comparison Report`);
  return artifact;
}

function expectedArtifact(
  execution: ExecutionRow,
  payload: ComparisonReportPayload,
  createdAt: string,
): ComparisonReportArtifact {
  if (!execution.sessionId || !execution.turnId) {
    throw new Error(`Execution ${execution.id} is not linked to the canonical session lifecycle`);
  }
  const artifact = ArtifactEnvelopeSchema.parse({
    artifactId: `artifact_comparison_report_${execution.id}`,
    kind: 'COMPARISON_REPORT',
    schemaVersion: 1,
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    executionId: execution.id,
    ticker: execution.ticker,
    payload,
    createdAt,
  });
  if (artifact.kind !== 'COMPARISON_REPORT') throw new Error(`Execution ${execution.id} did not produce a Comparison Report`);
  return artifact;
}

function referencedEvidenceTickers(payload: ComparisonReportPayload): Map<string, string> {
  const tickersById = new Map<string, string>();
  const add = (evidenceId: string, ticker: string) => {
    const existing = tickersById.get(evidenceId);
    if (existing !== undefined && existing !== ticker) {
      throw new Error(`Comparison Report Evidence ${evidenceId} is mapped to multiple subjects`);
    }
    tickersById.set(evidenceId, ticker);
  };

  for (const metric of payload.metrics) {
    for (const cell of metric.cells) add(cell.source.evidenceId, cell.ticker);
  }
  for (const difference of payload.differences) {
    add(difference.left.evidenceId, difference.leftTicker);
    add(difference.right.evidenceId, difference.rightTicker);
  }
  return tickersById;
}

function assertCanonicalLinks(db: Transaction, execution: ExecutionRow): void {
  if (execution.sessionId === null || execution.turnId === null || execution.attempt === null) {
    throw new Error(`Execution ${execution.id} is not linked to the canonical session lifecycle`);
  }
  const session = db.select().from(researchSessions).where(eq(researchSessions.id, execution.sessionId)).limit(1).get();
  const turn = db.select().from(researchTurns).where(eq(researchTurns.id, execution.turnId)).limit(1).get();
  if (!session || !turn || turn.sessionId !== execution.sessionId) {
    throw new Error(`Execution ${execution.id} does not have canonical Session/Turn links`);
  }
}

function validateEvidenceMemberships(
  tx: Transaction,
  executionId: string,
  tickersById: Map<string, string>,
): void {
  const evidenceIds = [...tickersById.keys()];
  if (evidenceIds.length === 0) return;

  // Read all cells and operands from the current Execution's membership in one transaction-scoped query.
  const rows = tx.select({ evidence, membership: runEvidence }).from(evidence)
    .leftJoin(runEvidence, and(eq(runEvidence.evidenceId, evidence.id), eq(runEvidence.runId, executionId)))
    .where(inArray(evidence.id, evidenceIds)).all();
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row.evidence.id;
    if (seen.has(id)) throw new Error(`Comparison Report Evidence ${id} is not unique for Execution ${executionId}`);
    seen.add(id);

    const membership = row.membership;
    if (!membership) throw new Error(`Comparison Report Evidence ${id} exists but has no membership in Execution ${executionId}`);
    if (membership.runId !== executionId) throw new Error(`Comparison Report Evidence ${id} does not belong to Execution ${executionId}`);
    if (membership.policyId !== EVIDENCE_POLICY_ID || membership.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT
      || membership.candidateKind !== 'financial') {
      throw new Error(`Comparison Report Evidence ${id} lacks current financial-policy acceptance`);
    }

    const acceptance = evidenceAcceptanceOf(membership);
    if (acceptance.legacy === true || acceptance.provenance.legacy === true) {
      throw new Error(`Comparison Report Evidence ${id} has legacy provenance`);
    }
    if (!membership.acceptedAt || !Number.isFinite(Date.parse(membership.acceptedAt))) {
      throw new Error(`Comparison Report Evidence ${id} has an invalid acceptedAt timestamp`);
    }
    if (membership.validAt !== null || acceptance.validAt !== null) {
      throw new Error(`Comparison Report Evidence ${id} must have validAt null`);
    }
    if (acceptance.provenance.observationKind !== 'quarterly_financials') {
      throw new Error(`Comparison Report Evidence ${id} is not quarterly_financials evidence`);
    }
    const expectedTicker = tickersById.get(id);
    if (expectedTicker === undefined || row.evidence.ticker !== expectedTicker) {
      throw new Error(`Comparison Report Evidence ${id} ticker does not match its matrix subject`);
    }
  }

  const missingIds = evidenceIds.filter(id => !seen.has(id));
  if (missingIds.length > 0) throw new Error(`Comparison Report Evidence not found: ${missingIds.join(', ')}`);
}

/** SQLite's one narrow transaction for Compare Execution completion and matrix publication. */
export class ComparisonReportPublicationStoreSqlite implements ComparisonReportPublicationStore {
  constructor(private readonly db: Orm) {}

  async completeAndPublish(params: {
    executionId: string;
    payload: ComparisonReportPayload;
    executionTimeSeconds: number;
  }): Promise<ComparisonReportPublication> {
    const payload = ComparisonReportPayloadSchema.parse(params.payload);
    if (!Number.isFinite(params.executionTimeSeconds) || params.executionTimeSeconds < 0) {
      throw new Error('Compare Execution time must be a finite non-negative number');
    }

    const tickersById = referencedEvidenceTickers(payload);
    return this.db.transaction((tx) => {
      const current = tx.select().from(executions).where(eq(executions.id, params.executionId)).limit(1).get();
      if (!current) throw new Error(`Execution ${params.executionId} not found`);
      assertCanonicalLinks(tx, current);
      if (current.command !== ARTIFACT_PRODUCER_BY_KIND.COMPARISON_REPORT) {
        throw new Error(`COMPARISON_REPORT requires a ${ARTIFACT_PRODUCER_BY_KIND.COMPARISON_REPORT} execution`);
      }
      if (current.ticker !== payload.subjects[0]?.ticker) {
        throw new Error(`Comparison Report first subject ticker must match Execution ${current.id} anchor ${current.ticker}`);
      }

      const artifactId = `artifact_comparison_report_${current.id}`;
      const existingById = tx.select().from(artifacts).where(eq(artifacts.artifactId, artifactId)).limit(1).get();
      const existingByScope = tx.select().from(artifacts).where(and(
        eq(artifacts.executionId, current.id), eq(artifacts.kind, 'COMPARISON_REPORT'),
      )).limit(1).get();

      if (current.status === 'completed') {
        const existing = existingById ?? existingByScope;
        if (!existing) throw new Error(`Completed Execution ${current.id} is missing its Comparison Report`);
        if (existingById && existingByScope && existingById.artifactId !== existingByScope.artifactId) {
          throw new Error(`Comparison Report ${current.id} immutable identity conflict`);
        }
        const stored = toComparisonReport(existing as ArtifactRow);
        const expected = expectedArtifact(current, payload, current.completedAt ?? '');
        if (canonicalJson(stored) !== canonicalJson(expected)) {
          throw new Error(`Comparison Report ${current.id} immutable write conflict`);
        }
        return { execution: toExecution(current), artifact: stored };
      }

      if (current.status !== 'running') {
        throw new Error(`Execution ${current.id} is already ${current.status} — no further transitions allowed`);
      }
      if (existingById || existingByScope) {
        throw new Error(`Comparison Report ${current.id} exists before Execution completion`);
      }

      validateEvidenceMemberships(tx, current.id, tickersById);

      const completedAt = new Date().toISOString();
      const artifact = expectedArtifact(current, payload, completedAt);
      const updated = tx.update(executions).set({
        status: 'completed',
        executionTime: params.executionTimeSeconds,
        error: null,
        completedAt,
      }).where(and(eq(executions.id, current.id), eq(executions.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Execution ${current.id} did not complete atomically`);

      tx.update(researchSessions).set({ updatedAt: completedAt }).where(eq(researchSessions.id, current.sessionId!)).run();
      tx.insert(artifacts).values({
        artifactId: artifact.artifactId,
        kind: artifact.kind,
        schemaVersion: artifact.schemaVersion,
        sessionId: artifact.sessionId,
        turnId: artifact.turnId,
        executionId: artifact.executionId,
        ticker: artifact.ticker,
        payloadJson: canonicalJson(artifact.payload),
        createdAt: artifact.createdAt,
      }).run();

      const settled = tx.select().from(executions).where(eq(executions.id, current.id)).limit(1).get();
      if (!settled) throw new Error(`Execution ${current.id} disappeared during publication`);
      return { execution: toExecution(settled), artifact };
    });
  }
}
