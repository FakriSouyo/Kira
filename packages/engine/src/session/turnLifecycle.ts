import type {
  ExecutionStatus,
  ResearchSessionStore,
  ResearchTurn,
  TurnStatus,
} from '@harness/session-core';
import type { WorkingContextPublisher } from './workingContextPublisher.js';

export type SettledTurnStatus = Exclude<TurnStatus, 'running'>;

export interface RunSessionTurnOptions<Result> {
  readonly sessions: Pick<ResearchSessionStore, 'createTurn' | 'getSessionArtifacts' | 'settleTurn'>;
  readonly publisher: Pick<WorkingContextPublisher, 'publishAfterSettledTurn'>;
  readonly sessionId: string;
  readonly input: string;
  readonly command: string;
  readonly signal?: AbortSignal;
  /** Allows host-local input lifecycles to retain their fixed failure status. */
  readonly failureStatus?: SettledTurnStatus;
  /** Host-owned classification for errors that represent cancellation. */
  readonly isAbortError?: (error: unknown) => boolean;
  readonly onTurnStarted: (turn: ResearchTurn) => void | Promise<void>;
  readonly action: (turn: ResearchTurn) => Promise<Result>;
  /** Called on the live failure path before canonical settlement. */
  readonly onTurnFailure?: (turn: ResearchTurn, status: SettledTurnStatus, error: unknown) => void | Promise<void>;
  readonly onTurnSettled: (turn: ResearchTurn) => void | Promise<void>;
}

/** Runs the canonical lifecycle for one newly accepted Session Turn. */
export async function runSessionTurn<Result>({
  sessions,
  publisher,
  sessionId,
  input,
  command,
  signal,
  failureStatus,
  isAbortError,
  onTurnStarted,
  action,
  onTurnFailure,
  onTurnSettled,
}: RunSessionTurnOptions<Result>): Promise<Result> {
  const turn = await sessions.createTurn({ sessionId, input, command });
  let turnSettled = false;

  try {
    await onTurnStarted(turn);
    const result = await action(turn);
    const settledTurn = await sessions.settleTurn(turn.id, 'completed');
    turnSettled = true;
    const artifacts = await sessions.getSessionArtifacts(sessionId);
    await publisher.publishAfterSettledTurn({ sessionId, turnId: turn.id, artifacts });
    await onTurnSettled(settledTurn);
    return result;
  } catch (error) {
    if (!turnSettled) {
      const status = failureStatus
        ?? await resolveLiveFailureStatus(sessions, sessionId, turn.id, error, signal, isAbortError);
      await onTurnFailure?.(turn, status, error);
      const settledTurn = await sessions.settleTurn(turn.id, status);
      turnSettled = true;
      await onTurnSettled(settledTurn);
    }
    throw error;
  }
}

/** Resolves a live action failure; restart recovery intentionally uses its own policy. */
async function resolveLiveFailureStatus(
  sessions: Pick<ResearchSessionStore, 'getSessionArtifacts'>,
  sessionId: string,
  turnId: string,
  error: unknown,
  signal?: AbortSignal,
  isAbortError?: (error: unknown) => boolean,
): Promise<SettledTurnStatus> {
  const artifacts = await sessions.getSessionArtifacts(sessionId);
  const executions = artifacts.executions.filter(execution => execution.turnId === turnId);
  const hasStatus = (status: ExecutionStatus) => executions.some(execution => execution.status === status);

  if (hasStatus('completed')) return 'completed';
  if (hasStatus('cancelled')) return 'stopped';
  if (hasStatus('failed')) return 'failed';
  return signal?.aborted || isAbortError?.(error) ? 'stopped' : 'failed';
}
