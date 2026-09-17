import { and, asc, eq } from 'drizzle-orm';
import {
  ArtifactEnvelopeSchema,
  type ArtifactEnvelope,
  type DurableArtifactRef,
} from '@harness/schemas';
import type { ArtifactStore } from '@harness/session-core';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { artifacts as artifactRows, executions } from './schema';

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

  async resolve(ref: DurableArtifactRef): Promise<ArtifactEnvelope | null> {
    const artifact = await this.getById(ref.artifactId);
    return artifact?.kind === ref.kind ? artifact : null;
  }
}
