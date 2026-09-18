import { eq } from 'drizzle-orm';
import {
  ContextSnapshotConflictError,
  ContextSnapshotIdSchema,
  ContextSnapshotSchema,
  contextSnapshotSemanticJson,
  freezeContextSnapshot,
  type ContextSnapshot,
  type ContextSnapshotId,
  type ContextSnapshotStore,
} from '@harness/context';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { contextSnapshots } from './schema';

type ContextSnapshotRow = typeof contextSnapshots.$inferSelect;

function toSnapshot(row: ContextSnapshotRow): ContextSnapshot {
  return freezeContextSnapshot(ContextSnapshotSchema.parse({
    snapshotId: row.snapshotId,
    schemaVersion: row.schemaVersion,
    sessionId: row.sessionId,
    turnId: row.turnId,
    workingContextVersion: row.workingContextVersion,
    packetFingerprint: row.packetFingerprint,
    packet: JSON.parse(row.packetJson) as unknown,
    createdAt: row.createdAt,
  }) as ContextSnapshot);
}

/** SQLite persistence for immutable PR H ContextSnapshots. */
export class ContextSnapshotStoreSqlite implements ContextSnapshotStore {
  constructor(private readonly db: Orm) {}

  async save(input: ContextSnapshot): Promise<ContextSnapshot> {
    const snapshot = ContextSnapshotSchema.parse(input) as ContextSnapshot;
    const packetJson = canonicalJson(snapshot.packet);
    await this.db.insert(contextSnapshots).values({
      snapshotId: snapshot.snapshotId,
      sessionId: snapshot.sessionId,
      turnId: snapshot.turnId,
      workingContextVersion: snapshot.workingContextVersion,
      schemaVersion: snapshot.schemaVersion,
      packetFingerprint: snapshot.packetFingerprint,
      packetJson,
      createdAt: snapshot.createdAt,
    }).onConflictDoNothing();

    const stored = await this.getById(snapshot.snapshotId);
    if (!stored) throw new Error(`ContextSnapshot ${snapshot.snapshotId} was not persisted`);
    if (contextSnapshotSemanticJson(stored) !== contextSnapshotSemanticJson(snapshot)) {
      throw new ContextSnapshotConflictError(snapshot.snapshotId, `ContextSnapshot ${snapshot.snapshotId} is immutable and conflicts with the existing record`);
    }
    return stored;
  }

  async getById(snapshotId: ContextSnapshotId): Promise<ContextSnapshot | null> {
    ContextSnapshotIdSchema.parse(snapshotId);
    const row = await this.db.select().from(contextSnapshots)
      .where(eq(contextSnapshots.snapshotId, snapshotId)).limit(1);
    return row[0] ? toSnapshot(row[0]) : null;
  }
}
