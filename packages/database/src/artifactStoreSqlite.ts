import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  ArtifactEnvelopeSchema,
  ArtifactRetrievalQuerySchema,
  type ArtifactEnvelope,
  type DurableArtifactRef,
} from '@harness/schemas';
import type { ArtifactSourceExecution, ArtifactStore } from '@harness/session-core';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { artifacts as artifactRows, conversationEvents, executions, researchTurns } from './schema';

type ArtifactRow = typeof artifactRows.$inferSelect;

function toEnvelope(row: ArtifactRow): ArtifactEnvelope {
  return ArtifactEnvelopeSchema.parse({
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
}

function comparable(artifact: ArtifactEnvelope): unknown {
  const { createdAt: _createdAt, ...withoutTimestamp } = artifact;
  return withoutTimestamp;
}

function assertSameArtifact(left: ArtifactEnvelope, right: ArtifactEnvelope): void {
  if (canonicalJson(comparable(left)) !== canonicalJson(comparable(right))) {
    throw new Error(`Artifact ${right.artifactId} immutable write conflict`);
  }
}

/** SQLite persistence for the small PR F artifact set. Rows are insert-only. */
export class ArtifactStoreSqlite implements ArtifactStore {
  constructor(private readonly db: Orm) {}

  async save(artifact: ArtifactEnvelope): Promise<ArtifactEnvelope> {
    const saved = await this.saveMany([artifact]);
    return saved[0]!;
  }

  async saveMany(input: readonly ArtifactEnvelope[]): Promise<ArtifactEnvelope[]> {
    const validated = input.map(artifact => ArtifactEnvelopeSchema.parse(artifact));
    if (validated.length === 0) return [];

    return this.db.transaction((tx) => {
      const saved: ArtifactEnvelope[] = [];
      for (const artifact of validated) {
        const execution = tx.select().from(executions).where(eq(executions.id, artifact.executionId)).limit(1).get();
        if (!execution) throw new Error(`Artifact ${artifact.artifactId} execution ${artifact.executionId} not found`);
        if (execution.status !== 'completed') throw new Error(`Artifact ${artifact.artifactId} requires a completed execution`);
        if (execution.command !== 'judge') throw new Error(`Artifact ${artifact.artifactId} requires a judge execution`);
        if (execution.sessionId !== artifact.sessionId || execution.turnId !== artifact.turnId) {
          throw new Error(`Artifact ${artifact.artifactId} lifecycle link does not match execution ${execution.id}`);
        }
        if (execution.ticker !== artifact.ticker) {
          throw new Error(`Artifact ${artifact.artifactId} ticker does not match execution ${execution.id}`);
        }

        const existingById = tx.select().from(artifactRows)
          .where(eq(artifactRows.artifactId, artifact.artifactId)).limit(1).get();
        const existingByScope = tx.select().from(artifactRows).where(and(
          eq(artifactRows.executionId, artifact.executionId), eq(artifactRows.kind, artifact.kind),
        )).limit(1).get();
        const existing = existingById ?? existingByScope;
        if (existing) {
          const stored = toEnvelope(existing as ArtifactRow);
          if (stored.artifactId !== artifact.artifactId) {
            throw new Error(`Artifact ${artifact.executionId}/${artifact.kind} immutable identity conflict`);
          }
          assertSameArtifact(stored, artifact);
          saved.push(stored);
          continue;
        }

        tx.insert(artifactRows).values({
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
        saved.push(artifact);
      }
      return saved;
    });
  }

  async getById(artifactId: string): Promise<ArtifactEnvelope | null> {
    const row = this.db.select().from(artifactRows).where(eq(artifactRows.artifactId, artifactId)).limit(1).get();
    return row ? toEnvelope(row as ArtifactRow) : null;
  }

  async getByExecution(executionId: string): Promise<ArtifactEnvelope[]> {
    const rows = this.db.select().from(artifactRows).where(eq(artifactRows.executionId, executionId)).orderBy(asc(artifactRows.createdAt)).all();
    const order = new Map<string, number>([['BULL_CASE', 0], ['BEAR_CASE', 1], ['VERDICT', 2]]);
    return rows.map(row => toEnvelope(row as ArtifactRow)).sort((a, b) => (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99));
  }

  async listByQuery(input: Parameters<ArtifactStore['listByQuery']>[0]): Promise<ArtifactEnvelope[]> {
    const query = ArtifactRetrievalQuerySchema.parse(input);
    const rows = await this.db.select({ artifact: artifactRows, execution: executions, turn: researchTurns })
      .from(artifactRows)
      .leftJoin(executions, eq(executions.id, artifactRows.executionId))
      .leftJoin(researchTurns, eq(researchTurns.id, artifactRows.turnId))
      .where(and(
        eq(artifactRows.sessionId, query.sessionId),
        inArray(artifactRows.ticker, query.subjects),
        inArray(artifactRows.kind, query.allowedKinds),
      ));

    // The journal's turn.started sequence is the durable acceptance watermark
    // used by SessionWorkingContext. Reuse it here so late settlement cannot
    // make an older Turn appear newer during artifact retrieval.
    const sourceSequences = new Map<string, number>();
    const journalRows = this.db.select({ sequence: conversationEvents.sequence, payload: conversationEvents.payload })
      .from(conversationEvents)
      .where(eq(conversationEvents.sessionId, query.sessionId))
      .all();
    for (const row of journalRows) {
      const payload = JSON.parse(row.payload) as { type?: string; id?: unknown; turnId?: unknown };
      if (payload.type === 'turn.started' && typeof payload.id === 'string' && payload.id === payload.turnId) {
        sourceSequences.set(payload.id, row.sequence);
      }
    }

    const kindOrder = new Map<string, number>([['BULL_CASE', 0], ['BEAR_CASE', 1], ['VERDICT', 2]]);
    rows.sort((left, right) => {
      const leftSequence = left.turn ? sourceSequences.get(left.turn.id) : undefined;
      const rightSequence = right.turn ? sourceSequences.get(right.turn.id) : undefined;
      if (leftSequence !== undefined && rightSequence !== undefined && leftSequence !== rightSequence) {
        return rightSequence - leftSequence;
      }

      // Legacy artifacts may predate the correlated turn.started journal row.
      // Only those comparisons fall back to the durable Turn timestamp.
      const turn = (right.turn?.startedAt ?? '').localeCompare(left.turn?.startedAt ?? '');
      if (turn !== 0) return turn;

      const attempt = (right.execution?.attempt ?? 0) - (left.execution?.attempt ?? 0);
      if (attempt !== 0) return attempt;

      const kind = (kindOrder.get(left.artifact.kind) ?? 99) - (kindOrder.get(right.artifact.kind) ?? 99);
      if (kind !== 0) return kind;

      const created = right.artifact.createdAt.localeCompare(left.artifact.createdAt);
      if (created !== 0) return created;
      return right.artifact.artifactId.localeCompare(left.artifact.artifactId);
    });
    return rows.slice(0, query.limit ?? 20).map(row => toEnvelope(row.artifact));
  }

  async getSourceExecution(executionId: string): Promise<ArtifactSourceExecution | null> {
    const row = await this.db.select().from(executions).where(eq(executions.id, executionId)).limit(1);
    if (!row[0] || row[0].sessionId === null || row[0].turnId === null || row[0].attempt === null) return null;
    return {
      id: row[0].id,
      sessionId: row[0].sessionId,
      turnId: row[0].turnId,
      attempt: row[0].attempt,
      ticker: row[0].ticker,
      command: row[0].command,
      status: row[0].status as ArtifactSourceExecution['status'],
      createdAt: row[0].createdAt,
      completedAt: row[0].completedAt,
    };
  }

  async resolve(ref: DurableArtifactRef): Promise<ArtifactEnvelope | null> {
    const artifact = await this.getById(ref.artifactId);
    return artifact?.kind === ref.kind ? artifact : null;
  }
}
