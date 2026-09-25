import type {
  ResearchExecution,
  ResearchSession,
  ResearchSessionArtifacts,
  ResearchSessionStore,
  ResearchTurn,
} from '@harness/session-core';
import { describe, expect, it, vi } from 'vitest';
import { reconcileSessionLifecycleAfterRestart } from '../src/session/restartReconciliation.js';

const session: ResearchSession = {
  id: 'session-1', title: 'Restart', provider: 'mock', model: 'mock-model',
  reasoningMode: 'usual', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeTurn(id: string, status: ResearchTurn['status'] = 'running'): ResearchTurn {
  return {
    id, sessionId: session.id, runId: null, input: 'research', command: 'judge', status,
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: status === 'running' ? null : '2026-01-01T00:01:00.000Z',
  };
}

function makeExecution(id: string, turnId: string, status: ResearchExecution['status']): ResearchExecution {
  return {
    id, sessionId: session.id, turnId, attempt: 1, ticker: 'BBCA', command: 'judge', status,
    executionTime: null, error: null, createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: status === 'running' || status === 'interrupted' ? null : '2026-01-01T00:01:00.000Z',
    resumeGeneration: 0,
  };
}

function makeStore(turns: ResearchTurn[], executions: ResearchExecution[]) {
  const calls: string[] = [];
  const currentTurns = [...turns];
  const currentExecutions = [...executions];
  const store: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'interruptExecution' | 'settleTurn'> = {
    async getSessionArtifacts(sessionId): Promise<ResearchSessionArtifacts> {
      calls.push(`get:${sessionId}`);
      return { session, turns: [...currentTurns], executions: [...currentExecutions], steps: [], modelCalls: [] };
    },
    async interruptExecution(executionId) {
      calls.push(`interrupt:${executionId}`);
      const index = currentExecutions.findIndex(execution => execution.id === executionId);
      const updated = { ...currentExecutions[index]!, status: 'interrupted' as const, completedAt: null };
      currentExecutions[index] = updated;
      return updated;
    },
    async settleTurn(turnId, status) {
      calls.push(`settle:${turnId}:${status}`);
      const index = currentTurns.findIndex(turn => turn.id === turnId);
      const updated = { ...currentTurns[index]!, status, completedAt: '2026-01-01T00:02:00.000Z' };
      currentTurns[index] = updated;
      return updated;
    },
  };
  return { store, calls, turns: currentTurns, executions: currentExecutions };
}

describe('reconcileSessionLifecycleAfterRestart', () => {
  it('does not mutate when no Execution or Turn is running', async () => {
    const fixture = makeStore([makeTurn('turn-1', 'completed')], [makeExecution('run-1', 'turn-1', 'completed')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(fixture.calls).toEqual(['get:session-1']);
    expect(result).toMatchObject({
      executions: [{ id: 'run-1', status: 'completed' }],
      settledTurns: [],
    });
  });

  it('interrupts a running Execution and returns the updated record', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'running')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.executions[0]).toMatchObject({ id: 'run-1', status: 'interrupted', completedAt: null, resumeGeneration: 0 });
    expect(result.settledTurns).toEqual([]);
    expect(fixture.turns[0]?.status).toBe('running');
  });

  it('leaves a Turn running when its only attempt is interrupted', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'interrupted')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([]);
    expect(fixture.turns[0]?.status).toBe('running');
    expect(fixture.calls).toEqual(['get:session-1']);
  });

  it('settles a running Turn as completed when any attempt completed', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'completed')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([expect.objectContaining({ id: 'turn-1', status: 'completed' })]);
    expect(fixture.calls).toContain('settle:turn-1:completed');
  });

  it('settles a running Turn as failed when any attempt failed and none completed', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'failed')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([expect.objectContaining({ id: 'turn-1', status: 'failed' })]);
  });

  it('gives completed attempts precedence over failed and interrupted attempts', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [
      makeExecution('run-interrupted', 'turn-1', 'interrupted'),
      makeExecution('run-failed', 'turn-1', 'failed'),
      makeExecution('run-completed', 'turn-1', 'completed'),
    ]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([expect.objectContaining({ status: 'completed' })]);
  });

  it('gives failed attempts precedence over interrupted attempts when none completed', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [
      makeExecution('run-interrupted', 'turn-1', 'interrupted'),
      makeExecution('run-failed', 'turn-1', 'failed'),
    ]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('settles a running Turn with zero attempts as stopped', async () => {
    const fixture = makeStore([makeTurn('turn-1')], []);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([expect.objectContaining({ id: 'turn-1', status: 'stopped' })]);
    expect(fixture.calls).toContain('settle:turn-1:stopped');
  });

  it('settles a running Turn with only cancelled attempts as stopped', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'cancelled')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([expect.objectContaining({ status: 'stopped' })]);
  });

  it('does not mutate terminal Turns', async () => {
    const fixture = makeStore([makeTurn('turn-completed', 'completed'), makeTurn('turn-failed', 'failed'), makeTurn('turn-stopped', 'stopped')], []);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(result.settledTurns).toEqual([]);
    expect(fixture.calls).toEqual(['get:session-1']);
  });

  it('does not interrupt terminal Executions', async () => {
    const fixture = makeStore([makeTurn('turn-1', 'completed')], [
      makeExecution('run-completed', 'turn-1', 'completed'),
      makeExecution('run-failed', 'turn-1', 'failed'),
      makeExecution('run-interrupted', 'turn-1', 'interrupted'),
      makeExecution('run-cancelled', 'turn-1', 'cancelled'),
    ]);

    await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(fixture.calls).toEqual(['get:session-1']);
  });

  it('propagates failures from lifecycle store operations', async () => {
    const cases = [
      {
        operation: 'getSessionArtifacts',
        fixture: () => makeStore([makeTurn('turn-1')], []),
        configure: (store: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'interruptExecution' | 'settleTurn'>, error: Error) =>
          vi.spyOn(store, 'getSessionArtifacts').mockRejectedValue(error),
      },
      {
        operation: 'interruptExecution',
        fixture: () => makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'running')]),
        configure: (store: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'interruptExecution' | 'settleTurn'>, error: Error) =>
          vi.spyOn(store, 'interruptExecution').mockRejectedValue(error),
      },
      {
        operation: 'settleTurn',
        fixture: () => makeStore([makeTurn('turn-1')], []),
        configure: (store: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'interruptExecution' | 'settleTurn'>, error: Error) =>
          vi.spyOn(store, 'settleTurn').mockRejectedValue(error),
      },
    ];

    for (const testCase of cases) {
      const fixture = testCase.fixture();
      const error = new Error(`${testCase.operation} failed`);
      testCase.configure(fixture.store, error);

      await expect(reconcileSessionLifecycleAfterRestart(fixture.store, session.id)).rejects.toBe(error);
    }
  });

  it('interrupts running Executions before deriving running Turn outcomes', async () => {
    const fixture = makeStore([makeTurn('turn-1')], [makeExecution('run-1', 'turn-1', 'running')]);

    const result = await reconcileSessionLifecycleAfterRestart(fixture.store, session.id);

    expect(fixture.calls).toEqual(['get:session-1', 'interrupt:run-1']);
    expect(result.executions[0]?.status).toBe('interrupted');
    expect(result.settledTurns).toEqual([]);
    expect(fixture.turns[0]?.status).toBe('running');
  });
});
