import { and, eq, inArray } from 'drizzle-orm';
import {
  ARTIFACT_PRODUCER_BY_KIND,
  ArtifactEnvelopeSchema,
  ResearchReportPayloadSchema,
  type ResearchReportPayload,
} from '@harness/schemas';
import type {
  ResearchExecution,
  ResearchReportArtifact,
  ResearchReportPublication,
  ResearchReportPublicationStore,
} from '@harness/session-core';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { evidenceAcceptanceOf } from './evidenceMembership';
import { artifacts, evidence, executions, researchSessions, runEvidence } from './schema';

type ArtifactRow = typeof artifacts.$inferSelect;
type ExecutionRow = typeof executions.$inferSelect;

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

function toResearchReport(row: ArtifactRow): ResearchReportArtifact {
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
  if (artifact.kind !== 'RESEARCH_REPORT') throw new Error(`Artifact ${row.artifactId} is not a Research Report`);
  return artifact;
}

function referencedEvidenceIds(payload: ResearchReportPayload): string[] {
  return [...new Set([
    ...payload.findings.flatMap(finding => [
      ...finding.evidenceIds,
      ...(finding.citedFigures ?? []).map(figure => figure.evidenceId),
    ]),
    ...payload.sourceAssessments.map(assessment => assessment.evidenceId),
    ...payload.coverage.flatMap(source => source.status === 'available' ? source.evidenceIds : []),
  ])];
}

function expectedArtifact(
  execution: ExecutionRow,
  payload: ResearchReportPayload,
  createdAt: string,
): ResearchReportArtifact {
  if (!execution.sessionId || !execution.turnId) {
    throw new Error(`Execution ${execution.id} is not linked to the canonical session lifecycle`);
  }
  const artifact = ArtifactEnvelopeSchema.parse({
    artifactId: `artifact_research_report_${execution.id}`,
    kind: 'RESEARCH_REPORT',
    schemaVersion: 1,
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    executionId: execution.id,
    ticker: execution.ticker,
    payload,
    createdAt,
  });
  if (artifact.kind !== 'RESEARCH_REPORT') throw new Error(`Execution ${execution.id} did not produce a Research Report`);
  return artifact;
}

/** SQLite's one narrow transaction for Research Execution completion and report publication. */
export class ResearchReportPublicationStoreSqlite implements ResearchReportPublicationStore {
  constructor(private readonly db: Orm) {}

  async completeAndPublish(params: {
    executionId: string;
    payload: ResearchReportPayload;
    executionTimeSeconds: number;
  }): Promise<ResearchReportPublication> {
    const payload = ResearchReportPayloadSchema.parse(params.payload);
    if (!Number.isFinite(params.executionTimeSeconds) || params.executionTimeSeconds < 0) {
      throw new Error('Research Execution time must be a finite non-negative number');
    }

    return this.db.transaction((tx) => {
      const current = tx.select().from(executions).where(eq(executions.id, params.executionId)).limit(1).get();
      if (!current) throw new Error(`Execution ${params.executionId} not found`);
      if (current.command !== ARTIFACT_PRODUCER_BY_KIND.RESEARCH_REPORT) {
        throw new Error(`RESEARCH_REPORT requires a ${ARTIFACT_PRODUCER_BY_KIND.RESEARCH_REPORT} execution`);
      }

      const artifactId = `artifact_research_report_${current.id}`;
      const existingById = tx.select().from(artifacts).where(eq(artifacts.artifactId, artifactId)).limit(1).get();
      const existingByScope = tx.select().from(artifacts).where(and(
        eq(artifacts.executionId, current.id), eq(artifacts.kind, 'RESEARCH_REPORT'),
      )).limit(1).get();

      if (current.status === 'completed') {
        const existing = existingById ?? existingByScope;
        if (!existing) throw new Error(`Completed Execution ${current.id} is missing its Research Report`);
        if (existingById && existingByScope && existingById.artifactId !== existingByScope.artifactId) {
          throw new Error(`Research Report ${current.id} immutable identity conflict`);
        }
        const stored = toResearchReport(existing as ArtifactRow);
        const expected = expectedArtifact(current, payload, current.completedAt ?? '');
        if (canonicalJson(stored) !== canonicalJson(expected)) {
          throw new Error(`Research Report ${current.id} immutable write conflict`);
        }
        return { execution: toExecution(current), artifact: stored };
      }

      if (current.status !== 'running') {
        throw new Error(`Execution ${current.id} is already ${current.status} — no further transitions allowed`);
      }
      if (existingById || existingByScope) {
        throw new Error(`Research Report ${current.id} exists before Execution completion`);
      }

      const evidenceIds = referencedEvidenceIds(payload);
      if (evidenceIds.length > 0) {
        // Match EvidenceStoreSqlite#getManyByIdsForRun inside this transaction to close the membership race.
        const memberships = tx.select({ evidence, membership: runEvidence }).from(runEvidence)
          .innerJoin(evidence, eq(runEvidence.evidenceId, evidence.id))
          .where(and(eq(runEvidence.runId, current.id), inArray(runEvidence.evidenceId, evidenceIds))).all();
        const acceptedIds = new Set<string>();
        for (const row of memberships) {
          evidenceAcceptanceOf(row.membership);
          acceptedIds.add(row.evidence.id);
        }
        const missingIds = evidenceIds.filter(id => !acceptedIds.has(id));
        if (missingIds.length > 0) {
          throw new Error(`Research Report Evidence is not accepted for Execution ${current.id}: ${missingIds.join(', ')}`);
        }
      }

      const completedAt = new Date().toISOString();
      const artifact = expectedArtifact(current, payload, completedAt);
      const updated = tx.update(executions).set({
        status: 'completed',
        executionTime: params.executionTimeSeconds,
        error: null,
        completedAt,
      }).where(and(eq(executions.id, current.id), eq(executions.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Execution ${current.id} did not complete atomically`);

      if (current.sessionId) {
        tx.update(researchSessions).set({ updatedAt: completedAt }).where(eq(researchSessions.id, current.sessionId)).run();
      }
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
      return { execution: toExecution(settled!), artifact };
    });
  }
}
