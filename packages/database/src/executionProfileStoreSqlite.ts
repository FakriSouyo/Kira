import { eq } from 'drizzle-orm';
import { canonicalJson } from '@harness/shared';
import {
  createExecutionProfile,
  ExecutionProfileConflictError,
  type ExecutionProfile,
  type ExecutionProfileStore,
  type JsonValue,
} from '@harness/session-core';
import type { Orm } from './client';
import { executionProfiles, executions } from './schema';

function toProfile(row: typeof executionProfiles.$inferSelect): ExecutionProfile {
  const profile = createExecutionProfile({
    executionId: row.executionId,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    graphFingerprint: row.graphFingerprint,
    command: row.command,
    ticker: row.ticker,
    payload: JSON.parse(row.payloadJson) as JsonValue,
    createdAt: row.createdAt,
  });
  if (row.schemaVersion !== profile.schemaVersion || row.fingerprint !== profile.fingerprint) {
    throw new Error(`Execution profile ${row.executionId} failed integrity validation`);
  }
  return profile;
}

/** Immutable SQLite persistence for the generic execution profile envelope. */
export class ExecutionProfileStoreSqlite implements ExecutionProfileStore {
  constructor(private readonly db: Orm) {}

  async save<TPayload extends JsonValue>(profile: ExecutionProfile<TPayload>): Promise<ExecutionProfile<TPayload>> {
    const canonical = createExecutionProfile({
      executionId: profile.executionId,
      workflowId: profile.workflowId,
      workflowVersion: profile.workflowVersion,
      graphFingerprint: profile.graphFingerprint,
      command: profile.command,
      ticker: profile.ticker,
      payload: profile.payload,
      createdAt: profile.createdAt,
    });
    if (profile.schemaVersion !== canonical.schemaVersion || profile.fingerprint !== canonical.fingerprint) {
      throw new ExecutionProfileConflictError(`Execution profile ${profile.executionId} has an invalid identity`);
    }

    return this.db.transaction((tx) => {
      const execution = tx.select().from(executions).where(eq(executions.id, profile.executionId)).limit(1).get();
      if (!execution || execution.sessionId === null || execution.turnId === null || execution.attempt === null) {
        throw new Error(`Execution ${profile.executionId} is not linked to the canonical session lifecycle`);
      }
      if (execution.command !== profile.command || execution.ticker !== profile.ticker) {
        throw new ExecutionProfileConflictError(`Execution profile ${profile.executionId} does not match its execution identity`);
      }
      const existing = tx.select().from(executionProfiles)
        .where(eq(executionProfiles.executionId, profile.executionId)).limit(1).get();
      if (existing) {
        const stored = toProfile(existing);
        // createdAt is operational metadata and is deliberately excluded from
        // the semantic fingerprint; a retry with the same semantic profile
        // must remain idempotent while retaining the original stored timestamp.
        if (stored.fingerprint === profile.fingerprint) return stored as ExecutionProfile<TPayload>;
        throw new ExecutionProfileConflictError(`Execution profile ${profile.executionId} is immutable and already has a different value`);
      }
      tx.insert(executionProfiles).values({
        executionId: profile.executionId,
        schemaVersion: profile.schemaVersion,
        workflowId: profile.workflowId,
        workflowVersion: profile.workflowVersion,
        graphFingerprint: profile.graphFingerprint,
        command: profile.command,
        ticker: profile.ticker,
        payloadJson: canonicalJson(profile.payload),
        fingerprint: profile.fingerprint,
        createdAt: profile.createdAt,
      }).run();
      return profile;
    });
  }

  async getByExecutionId<TPayload extends JsonValue = JsonValue>(executionId: string): Promise<ExecutionProfile<TPayload> | null> {
    const row = await this.db.select().from(executionProfiles).where(eq(executionProfiles.executionId, executionId)).limit(1);
    return row[0] ? toProfile(row[0]) as ExecutionProfile<TPayload> : null;
  }
}
