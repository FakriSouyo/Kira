import type {
  ResearchExecution,
  ResearchSessionStore,
  ResearchTurn,
} from '@harness/session-core';

export interface SessionRestartReconciliation {
  readonly executions: readonly ResearchExecution[];
  readonly settledTurns: readonly ResearchTurn[];
}

/** Reconciles canonical Session lifecycle state left in flight by process loss. */
export async function reconcileSessionLifecycleAfterRestart(
  sessions: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'interruptExecution' | 'settleTurn'>,
  sessionId: string,
): Promise<SessionRestartReconciliation> {
  const artifacts = await sessions.getSessionArtifacts(sessionId);
  const executions = new Map(artifacts.executions.map(execution => [execution.id, execution]));

  for (const execution of executions.values()) {
    if (execution.status === 'running') {
      executions.set(execution.id, await sessions.interruptExecution(execution.id));
    }
  }

  const settledTurns: ResearchTurn[] = [];
  for (const turn of artifacts.turns) {
    if (turn.status !== 'running') continue;
    const attempts = [...executions.values()].filter(execution => execution.turnId === turn.id);
    const status = attempts.some(execution => execution.status === 'completed')
      ? 'completed' as const
      : attempts.some(execution => execution.status === 'failed')
        ? 'failed' as const
        : attempts.some(execution => execution.status === 'interrupted')
          ? null
          : 'stopped' as const;
    if (status === null) continue;
    settledTurns.push(await sessions.settleTurn(turn.id, status));
  }

  return { executions: [...executions.values()], settledTurns };
}
