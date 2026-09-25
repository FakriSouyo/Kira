import type {
  ExecutionStatus,
  ResearchSessionStore,
  ResearchTurn,
  TurnStatus,
} from '@harness/session-core';
import type { WorkingContextPublisher } from './workingContextPublisher.js';

export type AttachedTurnStatus = Exclude<TurnStatus, 'running'>;

export interface RunAttachedSessionTurnOptions<Result> {
  readonly sessions: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'settleTurn'>;
  readonly publisher: Pick<WorkingContextPublisher, 'publishAfterSettledTurn'>;
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly action: () => Promise<Result>;
  readonly onTurnReleased: () => void | Promise<void>;
  readonly onTurnSettled: (turn: ResearchTurn, status: AttachedTurnStatus) => void | Promise<void>;
}

/** Coordinates lifecycle around an already attached canonical Turn and Execution. */
export async function runAttachedSessionTurn<Result>({
  sessions,
  publisher,
  sessionId,
  turnId,
  executionId,
  action,
  onTurnReleased,
  onTurnSettled,
}: RunAttachedSessionTurnOptions<Result>): Promise<Result> {
  let turnSettled = false;
  try {
    const result = await action();
    const artifacts = await sessions.getSessionArtifacts(sessionId);
    const execution = artifacts.executions.find(candidate => candidate.id === executionId);
    const status = execution ? attachedTurnSuccessStatus(execution.status) : null;

    if (status) {
      const settledTurn = await sessions.settleTurn(turnId, status);
      turnSettled = true;
      const settledArtifacts = await sessions.getSessionArtifacts(sessionId);
      await publisher.publishAfterSettledTurn({ sessionId, turnId, artifacts: settledArtifacts });
      await onTurnSettled(settledTurn, status);
    } else {
      await onTurnReleased();
    }

    return result;
  } catch (error) {
    if (turnSettled) {
      // Match the original attached-turn outer catch: once canonical settlement
      // succeeds, later infrastructure/projection failures only release the host.
      try {
        await sessions.getSessionArtifacts(sessionId);
      } catch (reconciliationError) {
        // The source catch reloaded before releasing. Keep cleanup guaranteed if
        // that catch-path reload also fails, and propagate the reload failure.
        await onTurnReleased();
        throw reconciliationError;
      }
      await onTurnReleased();
    } else {
      // Before canonical settlement, the original catch reloaded and reconciled
      // again. Keep this distinct from normal-success classification so a still-
      // running Execution remains attached when the host action itself throws.
      const artifacts = await sessions.getSessionArtifacts(sessionId);
      const execution = artifacts.executions.find(candidate => candidate.id === executionId);
      const status = execution ? attachedTurnFailureStatus(execution.status) : null;

      if (status) {
        const settledTurn = await sessions.settleTurn(turnId, status);
        turnSettled = true;
        await onTurnSettled(settledTurn, status);
      } else {
        await onTurnReleased();
      }
    }

    throw error;
  }
}

/** A normal host return treats a still-running attached Execution as failed. */
function attachedTurnSuccessStatus(status: ExecutionStatus): AttachedTurnStatus | null {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'stopped';
  if (status === 'failed') return 'failed';
  if (status === 'running') return 'failed';
  return null;
}

/** A thrown host action leaves running/interrupted Executions resumable. */
function attachedTurnFailureStatus(status: ExecutionStatus): AttachedTurnStatus | null {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'stopped';
  if (status === 'failed') return 'failed';
  return null;
}
