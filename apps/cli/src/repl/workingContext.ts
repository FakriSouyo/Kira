import type { FinharnessDatabase } from '@harness/database';
import {
  deriveWorkingContextPatch,
  isWorkingContextPatchNoOp,
  StaleWorkingContextError,
  type ConversationEvent,
  type ResearchSessionArtifacts,
  type SessionWorkingContext,
} from '@harness/session-core';

/**
 * Publishes `SessionWorkingContext` from settled canonical work (PR D).
 *
 * Publication rules:
 * - only a Turn whose canonical status is `completed` may publish;
 * - the patch is derived from durable rows only (Turn, completed Executions, and
 *   a persisted judgment reached through `JudgmentStore.getByRun`);
 * - a conversational Turn legitimately has zero Executions and only refreshes
 *   `currentIntent`;
 * - the journal event is an audit/reference append, never the context store.
 */
export type WorkingContextPublishStatus = 'committed' | 'skipped' | 'stale' | 'audit_failed';

export interface WorkingContextPublisher {
  /** Publishes after a Turn settled. Returns what happened so callers can assert it. */
  publishAfterSettledTurn(params: {
    sessionId: string;
    turnId: string;
    artifacts: ResearchSessionArtifacts;
  }): Promise<{ status: WorkingContextPublishStatus; version: number | null }>;
  /** Re-appends context audit events missing after a failed append; returns how many were repaired. */
  reconcileJournal(sessionId: string): Promise<number>;
}

/** Session-lifecycle commands never publish working context. */
const NON_PUBLISHING_COMMANDS = new Set(['new']);

/**
 * The Turn's acceptance watermark orders completions by request order rather
 * than by whichever completion happened to observe the journal last.
 */
function turnSourceSequence(db: FinharnessDatabase, sessionId: string, turnId: string): number | null {
  return db.journal.read(sessionId)
    .find(entry => entry.payload.type === 'turn.started'
      && entry.payload.turnId === turnId
      && entry.payload.id === turnId)?.sequence ?? null;
}

export function createWorkingContextPublisher(params: {
  db: FinharnessDatabase;
  /** Journal append from the conversation controller, so correlation stays canonical. */
  append: (payload: ConversationEvent) => unknown;
}): WorkingContextPublisher {
  const { db, append } = params;

  const contextEvent = (context: SessionWorkingContext, turnId: string): ConversationEvent => ({
    type: 'session.context.updated',
    id: `context_${context.sessionId}_v${context.version}`,
    sessionId: context.sessionId,
    turnId,
    oldVersion: context.version - 1,
    newVersion: context.version,
    sourceSequence: context.sourceSequence,
  });

  return {
    async publishAfterSettledTurn({ sessionId, turnId, artifacts }) {
      // Durable verification: only a canonically settled Turn may publish, so a
      // caller holding a stale in-memory Turn cannot promote partial work.
      const turn = artifacts.turns.find(candidate => candidate.id === turnId);
      if (!turn || turn.status !== 'completed' || NON_PUBLISHING_COMMANDS.has(turn.command)) {
        return { status: 'skipped', version: null };
      }
      const executions = artifacts.executions
        .filter(execution => execution.turnId === turn.id && execution.status === 'completed');
      const judgedExecutionIds: string[] = [];
      for (const execution of executions) {
        if (execution.command !== 'judge') continue;
        // Defined store lookup: a reference is created only when it resolves.
        if (await db.judgments.getByRun(execution.id)) judgedExecutionIds.push(execution.id);
      }
      const patch = deriveWorkingContextPatch({
        command: turn.command,
        executions: executions.map(execution => ({ executionId: execution.id, ticker: execution.ticker, command: execution.command })),
        judgedExecutionIds,
      });
      const current = await db.workingContext.current(sessionId);
      if (isWorkingContextPatchNoOp(current, patch)) return { status: 'skipped', version: current?.version ?? null };
      const sourceSequence = turnSourceSequence(db, sessionId, turn.id);
      // Without the canonical acceptance watermark, publishing would require
      // a second ordering source and could let a late completion look newer.
      if (sourceSequence === null) return { status: 'skipped', version: current?.version ?? null };

      let committed: SessionWorkingContext;
      try {
        committed = await db.workingContext.commit({
          sessionId,
          expectedVersion: current?.version ?? 0,
          sourceSequence,
          updatedByTurnId: turn.id,
          patch,
        });
      } catch (error) {
        // An older Turn settling late must not overwrite newer session state.
        if (error instanceof StaleWorkingContextError) return { status: 'stale', version: current?.version ?? null };
        throw error;
      }

      try {
        append(contextEvent(committed, turn.id));
      } catch {
        // Durable version wins over the audit append (PR B principle); the missing
        // event is repaired deterministically when the session is restored.
        return { status: 'audit_failed', version: committed.version };
      }
      return { status: 'committed', version: committed.version };
    },

    async reconcileJournal(sessionId) {
      const versions = await db.workingContext.history(sessionId);
      if (versions.length === 0) return 0;
      const recorded = new Set(db.journal.read(sessionId)
        .flatMap(entry => (entry.payload.type === 'session.context.updated' ? [entry.payload.newVersion] : [])));
      let repaired = 0;
      for (const version of versions) {
        // An orphaned version (Turn cascade-deleted) cannot be attributed, so no
        // audit event is fabricated for it.
        if (recorded.has(version.version) || version.updatedByTurnId === null) continue;
        try {
          append(contextEvent(version, version.updatedByTurnId));
        } catch {
          break;
        }
        repaired += 1;
      }
      return repaired;
    },
  };
}
