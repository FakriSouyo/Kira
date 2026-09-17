import { and, asc, desc, eq } from 'drizzle-orm';
import {
  applyWorkingContextPatch,
  assertWorkingContextCommit,
  StaleWorkingContextError,
  type SessionWorkingContext,
  type WorkingContextPatch,
  type WorkingContextStore,
} from '@harness/session-core';
import type { Orm } from './client';
import { sessionContextVersions } from './schema';

type VersionRow = typeof sessionContextVersions.$inferSelect;

/** The payload is self-describing; the key columns stay authoritative. */
function toWorkingContext(row: VersionRow): SessionWorkingContext {
  const payload = JSON.parse(row.payloadJson) as SessionWorkingContext;
  return {
    ...payload,
    sessionId: row.sessionId,
    version: row.version,
    sourceSequence: row.sourceSequence,
    updatedByTurnId: row.updatedByTurnId,
  };
}

/**
 * SQLite working-context storage (PR D). Compare-and-set is enforced inside one
 * transaction: the read-check rejects a writer that observed an older version or
 * journal sequence, and the primary key rejects a concurrent duplicate version.
 */
export class WorkingContextStoreSqlite implements WorkingContextStore {
  constructor(private readonly db: Orm) {}

  async current(sessionId: string): Promise<SessionWorkingContext | null> {
    const row = this.db.select().from(sessionContextVersions)
      .where(eq(sessionContextVersions.sessionId, sessionId))
      .orderBy(desc(sessionContextVersions.version)).limit(1).get();
    return row ? toWorkingContext(row) : null;
  }

  async at(sessionId: string, version: number): Promise<SessionWorkingContext | null> {
    const row = this.db.select().from(sessionContextVersions)
      .where(and(eq(sessionContextVersions.sessionId, sessionId), eq(sessionContextVersions.version, version)))
      .get();
    return row ? toWorkingContext(row) : null;
  }

  async history(sessionId: string, limit?: number): Promise<SessionWorkingContext[]> {
    const rows = this.db.select().from(sessionContextVersions)
      .where(eq(sessionContextVersions.sessionId, sessionId))
      .orderBy(asc(sessionContextVersions.version)).all();
    const selected = limit === undefined ? rows : rows.slice(Math.max(0, rows.length - limit));
    return selected.map(toWorkingContext);
  }

  async commit(params: {
    sessionId: string;
    expectedVersion: number;
    sourceSequence: number;
    updatedByTurnId: string | null;
    patch: WorkingContextPatch;
    at?: string;
  }): Promise<SessionWorkingContext> {
    return this.db.transaction((tx) => {
      const latestRow = tx.select().from(sessionContextVersions)
        .where(eq(sessionContextVersions.sessionId, params.sessionId))
        .orderBy(desc(sessionContextVersions.version)).limit(1).get();
      const latest = latestRow ? toWorkingContext(latestRow) : null;
      assertWorkingContextCommit(latest, {
        sessionId: params.sessionId,
        expectedVersion: params.expectedVersion,
        sourceSequence: params.sourceSequence,
      });
      const next = applyWorkingContextPatch(latest, {
        sessionId: params.sessionId,
        sourceSequence: params.sourceSequence,
        updatedByTurnId: params.updatedByTurnId,
        updatedAt: params.at ?? new Date().toISOString(),
        patch: params.patch,
      });
      const inserted = tx.insert(sessionContextVersions).values({
        sessionId: next.sessionId,
        version: next.version,
        sourceSequence: next.sourceSequence,
        payloadJson: JSON.stringify(next),
        updatedByTurnId: next.updatedByTurnId,
        ...(params.at ? { createdAt: params.at } : {}),
      }).onConflictDoNothing().run();
      if (inserted.changes !== 1) {
        throw new StaleWorkingContextError(
          'STALE_CONTEXT_VERSION', params.sessionId,
          `Session ${params.sessionId} working context version ${next.version} was committed concurrently`,
        );
      }
      return next;
    });
  }
}