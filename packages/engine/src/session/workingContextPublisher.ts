import type { JudgmentStore } from '@harness/execution';
import {
  deriveWorkingContextPatch,
  isWorkingContextPatchNoOp,
  StaleWorkingContextError,
  type ArtifactStore,
  type ConversationEntry,
  type ConversationEvent,
  type ResearchSessionArtifacts,
  type SessionWorkingContext,
  type WorkingContextStore,
} from '@harness/session-core';
import type { DurableArtifactRef } from '@harness/schemas';

/**
 * Publishes `SessionWorkingContext` from settled canonical work (PR D).
 *
 * Publication rules:
 * - only a Turn whose canonical status is `completed` may publish;
 * - the patch is derived from durable rows only (Turn, completed Executions, and
 *   persisted artifacts resolved through the typed artifact store (legacy
 *   judgments remain readable for pre-PR-F executions);
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
function turnSourceSequence(readJournal: (sessionId: string) => readonly ConversationEntry[], sessionId: string, turnId: string): number | null {
  return readJournal(sessionId)
    .find(entry => entry.payload.type === 'turn.started'
      && entry.payload.turnId === turnId
      && entry.payload.id === turnId)?.sequence ?? null;
}

export function createWorkingContextPublisher(params: {
  readonly workingContext: WorkingContextStore;
  readonly artifacts: ArtifactStore;
  readonly judgments: JudgmentStore;
  readonly readJournal: (sessionId: string) => readonly ConversationEntry[];
  /** Host append path preserves journal correlation and causation. */
  readonly appendAuditEvent: (payload: ConversationEvent) => unknown;
}): WorkingContextPublisher {
  const {
    workingContext,
    artifacts: artifactStore,
    judgments,
    readJournal,
    appendAuditEvent,
  } = params;

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
      const artifactRefs: DurableArtifactRef[] = [];
      for (const execution of executions) {
        if (execution.command !== 'judge') continue;
        const resolved = await artifactStore.getByExecution(execution.id);
        if (resolved.length > 0) {
          artifactRefs.push(...resolved.map(artifact => ({ kind: artifact.kind, artifactId: artifact.artifactId })));
        } else if (await judgments.getByRun(execution.id)) {
          // Defined legacy lookup: pre-PR-F rows keep their readable PR D ref.
          judgedExecutionIds.push(execution.id);
        }
      }
      const patch = deriveWorkingContextPatch({
        command: turn.command,
        executions: executions.map(execution => ({ executionId: execution.id, ticker: execution.ticker, command: execution.command })),
        judgedExecutionIds,
        artifactRefs: artifactRefs.length > 0 ? artifactRefs : undefined,
      });
      const current = await workingContext.current(sessionId);
      if (isWorkingContextPatchNoOp(current, patch)) return { status: 'skipped', version: current?.version ?? null };
      const sourceSequence = turnSourceSequence(readJournal, sessionId, turn.id);
      // Without the canonical acceptance watermark, publishing would require
      // a second ordering source and could let a late completion look newer.
      if (sourceSequence === null) return { status: 'skipped', version: current?.version ?? null };

      let committed: SessionWorkingContext;
      try {
        committed = await workingContext.commit({
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
        appendAuditEvent(contextEvent(committed, turn.id));
      } catch {
        // Durable version wins over the audit append (PR B principle); the missing
        // event is repaired deterministically when the session is restored.
        return { status: 'audit_failed', version: committed.version };
      }
      return { status: 'committed', version: committed.version };
    },

    async reconcileJournal(sessionId) {
      const versions = await workingContext.history(sessionId);
      if (versions.length === 0) return 0;
      const recorded = new Set(readJournal(sessionId)
        .flatMap(entry => (entry.payload.type === 'session.context.updated' ? [entry.payload.newVersion] : [])));
      let repaired = 0;
      for (const version of versions) {
        // An orphaned version (Turn cascade-deleted) cannot be attributed, so no
        // audit event is fabricated for it.
        if (recorded.has(version.version) || version.updatedByTurnId === null) continue;
        try {
          appendAuditEvent(contextEvent(version, version.updatedByTurnId));
        } catch {
          break;
        }
        repaired += 1;
      }
      return repaired;
    },
  };
}
