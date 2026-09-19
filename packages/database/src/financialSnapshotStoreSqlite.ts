import { and, eq, inArray } from 'drizzle-orm';
import {
  createVerifiedFinancialSnapshot,
  FinancialSnapshotConflictError,
  financialSnapshotSemanticJson,
  freezeVerifiedFinancialSnapshot,
  type FinancialSnapshotStore,
  type VerifiedFinancialSnapshot,
} from '@harness/financial-data';
import type { Orm } from './client';
import { executions, evidence, financialSnapshots, researchSessions, researchTurns, runEvidence } from './schema';

type FinancialSnapshotRow = typeof financialSnapshots.$inferSelect;

function toSnapshot(row: FinancialSnapshotRow): VerifiedFinancialSnapshot {
  let payload: Omit<VerifiedFinancialSnapshot, 'snapshotId' | 'fingerprint' | 'createdAt' | 'finalizedAt'>;
  try {
    payload = JSON.parse(row.payloadJson) as Omit<VerifiedFinancialSnapshot, 'snapshotId' | 'fingerprint' | 'createdAt' | 'finalizedAt'>;
  } catch {
    throw new Error(`Financial snapshot ${row.snapshotId} has invalid payload JSON`);
  }

  const snapshot = {
    ...payload,
    snapshotId: row.snapshotId,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
  } as VerifiedFinancialSnapshot;
  const expected = createVerifiedFinancialSnapshot({
    sessionId: snapshot.sessionId,
    turnId: snapshot.turnId,
    executionId: snapshot.executionId,
    ticker: snapshot.subject.ticker,
    requestedAsOf: snapshot.requestedAsOf,
    executionStartedAt: snapshot.executionStartedAt,
    finalizedAt: snapshot.finalizedAt,
    observations: snapshot.observations,
    materializedEvidenceIds: snapshot.materializedEvidenceIds,
  });
  if (expected.snapshotId !== snapshot.snapshotId || expected.fingerprint !== snapshot.fingerprint
    || financialSnapshotSemanticJson(expected) !== financialSnapshotSemanticJson(snapshot)) {
    throw new Error(`Financial snapshot ${row.snapshotId} failed integrity validation`);
  }
  return freezeVerifiedFinancialSnapshot(snapshot);
}

function assertSameSnapshot(stored: VerifiedFinancialSnapshot, input: VerifiedFinancialSnapshot): void {
  if (financialSnapshotSemanticJson(stored) !== financialSnapshotSemanticJson(input)) {
    throw new FinancialSnapshotConflictError(
      input.snapshotId,
      `Financial snapshot ${input.executionId} is immutable and conflicts with the existing record`,
    );
  }
}

/** SQLite persistence for PR N's insert-only, execution-scoped snapshot manifest. */
export class FinancialSnapshotStoreSqlite implements FinancialSnapshotStore {
  constructor(private readonly db: Orm) {}

  async save(input: VerifiedFinancialSnapshot): Promise<VerifiedFinancialSnapshot> {
    return this.db.transaction((tx) => {
      const expected = createVerifiedFinancialSnapshot({
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionId: input.executionId,
        ticker: input.subject.ticker,
        requestedAsOf: input.requestedAsOf,
        executionStartedAt: input.executionStartedAt,
        finalizedAt: input.finalizedAt,
        observations: input.observations,
        materializedEvidenceIds: input.materializedEvidenceIds,
      });
      if (expected.snapshotId !== input.snapshotId || expected.fingerprint !== input.fingerprint) {
        throw new Error(`Financial snapshot ${input.snapshotId} failed identity validation`);
      }

      const execution = tx.select().from(executions).where(eq(executions.id, input.executionId)).limit(1).get();
      if (!execution) throw new Error(`Financial snapshot ${input.snapshotId} execution ${input.executionId} not found`);
      if (execution.command !== 'judge') throw new Error(`Financial snapshot ${input.snapshotId} requires a judge execution`);
      if (execution.sessionId !== input.sessionId) throw new Error(`Financial snapshot ${input.snapshotId} session does not match execution ${execution.id}`);
      if (execution.turnId !== input.turnId) throw new Error(`Financial snapshot ${input.snapshotId} turn does not match execution ${execution.id}`);
      if (execution.ticker.toUpperCase() !== input.subject.ticker.toUpperCase()) throw new Error(`Financial snapshot ${input.snapshotId} ticker does not match execution ${execution.id}`);

      const evidenceIds = [...input.materializedEvidenceIds];
      if (new Set(evidenceIds).size !== evidenceIds.length) {
        throw new Error(`Financial snapshot ${input.snapshotId} contains duplicate Evidence references`);
      }
      if (evidenceIds.length > 0) {
        const linkedEvidence = tx.select({ evidenceId: runEvidence.evidenceId, ticker: evidence.ticker })
          .from(runEvidence)
          .innerJoin(evidence, eq(runEvidence.evidenceId, evidence.id))
          .where(and(
            eq(runEvidence.runId, input.executionId),
            inArray(runEvidence.evidenceId, evidenceIds),
          )).all();
        const linkedIds = new Set(
          linkedEvidence
            .filter(row => row.ticker.toUpperCase() === input.subject.ticker.toUpperCase())
            .map(row => row.evidenceId),
        );
        if (linkedIds.size !== evidenceIds.length) {
          throw new Error(`Financial snapshot ${input.snapshotId} references Evidence outside execution ${input.executionId}`);
        }
      }

      const session = tx.select({ id: researchSessions.id }).from(researchSessions)
        .where(eq(researchSessions.id, input.sessionId)).limit(1).get();
      if (!session) throw new Error(`Financial snapshot ${input.snapshotId} session ${input.sessionId} not found`);
      const turn = tx.select().from(researchTurns).where(eq(researchTurns.id, input.turnId)).limit(1).get();
      if (!turn) throw new Error(`Financial snapshot ${input.snapshotId} turn ${input.turnId} not found`);
      if (turn.sessionId !== input.sessionId) throw new Error(`Financial snapshot ${input.snapshotId} turn does not belong to session ${input.sessionId}`);

      const existingById = tx.select().from(financialSnapshots)
        .where(eq(financialSnapshots.snapshotId, input.snapshotId)).limit(1).get();
      const existingByExecution = tx.select().from(financialSnapshots)
        .where(eq(financialSnapshots.executionId, input.executionId)).limit(1).get();
      const existing = existingById ?? existingByExecution;
      if (existing) {
        const stored = toSnapshot(existing as FinancialSnapshotRow);
        if (stored.snapshotId !== input.snapshotId || stored.executionId !== input.executionId) {
          throw new FinancialSnapshotConflictError(
            input.snapshotId,
            `Financial snapshot ${input.executionId} already has an immutable record`,
          );
        }
        assertSameSnapshot(stored, input);
        return stored;
      }

      tx.insert(financialSnapshots).values({
        snapshotId: input.snapshotId,
        schemaVersion: input.schemaVersion,
        sessionId: input.sessionId,
        turnId: input.turnId,
        executionId: input.executionId,
        ticker: input.subject.ticker,
        payloadJson: financialSnapshotSemanticJson(input),
        fingerprint: input.fingerprint,
        createdAt: input.createdAt,
        finalizedAt: input.finalizedAt,
      }).run();
      const inserted = tx.select().from(financialSnapshots)
        .where(eq(financialSnapshots.snapshotId, input.snapshotId)).limit(1).get();
      if (!inserted) throw new Error(`Financial snapshot ${input.snapshotId} was not persisted`);
      return toSnapshot(inserted as FinancialSnapshotRow);
    });
  }

  async getById(snapshotId: string): Promise<VerifiedFinancialSnapshot | null> {
    const row = this.db.select().from(financialSnapshots)
      .where(eq(financialSnapshots.snapshotId, snapshotId)).limit(1).get();
    return row ? toSnapshot(row as FinancialSnapshotRow) : null;
  }

  async getByExecutionId(executionId: string): Promise<VerifiedFinancialSnapshot | null> {
    const row = this.db.select().from(financialSnapshots)
      .where(eq(financialSnapshots.executionId, executionId)).limit(1).get();
    return row ? toSnapshot(row as FinancialSnapshotRow) : null;
  }
}
