import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutionStatus,
  ResearchExecution,
  ResearchSessionArtifacts,
  ResearchSessionStore,
  ResearchTurn,
  TurnStatus,
} from '@harness/session-core';
import { runAttachedSessionTurn, type WorkingContextPublisher } from '../src/index.js';

const sessionId = 'session_attached';
const turnId = 'turn_attached';
const executionId = 'execution_attached';
const timestamp = '2026-09-25T00:00:00.000Z';

const runningTurn: ResearchTurn = {
  id: turnId,
  sessionId,
  runId: null,
  input: '/resume execution_attached',
  command: 'judge',
  status: 'running',
  startedAt: timestamp,
  completedAt: null,
};

function makeExecution(status: ExecutionStatus, id = executionId): ResearchExecution {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return {
    id,
    sessionId,
    turnId,
    attempt: 1,
    ticker: 'BBRI',
    command: 'judge',
    status,
    executionTime: null,
    error: null,
    createdAt: timestamp,
    completedAt: terminal ? timestamp : null,
    resumeGeneration: 1,
  };
}

function makeArtifacts(executions: ResearchExecution[] = [makeExecution('completed')], turn = runningTurn): ResearchSessionArtifacts {
  return {
    session: {
      id: sessionId,
      title: 'Attached session',
      provider: 'mock',
      model: 'mock',
      reasoningMode: 'usual',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    turns: [turn],
    executions,
    steps: [],
    modelCalls: [],
  };
}

function setup(options: {
  readonly executionStatus?: ExecutionStatus;
  readonly includeExecution?: boolean;
  readonly extraExecutions?: ResearchExecution[];
} = {}) {
  const events: string[] = [];
  const targetExecution = makeExecution(options.executionStatus ?? 'completed');
  let currentArtifacts = makeArtifacts([
    ...(options.extraExecutions ?? []),
    ...(options.includeExecution === false ? [] : [targetExecution]),
  ]);
  const sessions: Pick<ResearchSessionStore, 'getSessionArtifacts' | 'settleTurn'> = {
    getSessionArtifacts: vi.fn(async (_sessionId: string) => {
      events.push('reload');
      return currentArtifacts;
    }),
    settleTurn: vi.fn(async (requestedTurnId: string, status: Exclude<TurnStatus, 'running'>) => {
      events.push(`settle:${requestedTurnId}:${status}`);
      const settled: ResearchTurn = {
        ...runningTurn,
        id: requestedTurnId,
        status,
        completedAt: '2026-09-25T00:00:01.000Z',
      };
      currentArtifacts = { ...currentArtifacts, turns: [settled] };
      return settled;
    }),
  };
  const publisher: Pick<WorkingContextPublisher, 'publishAfterSettledTurn'> = {
    publishAfterSettledTurn: vi.fn(async () => {
      events.push('publish');
      return { status: 'skipped' as const, version: null };
    }),
  };
  const onTurnReleased = vi.fn(() => { events.push('released'); });
  const onTurnSettled = vi.fn((_turn: ResearchTurn, _status: Exclude<TurnStatus, 'running'>) => { events.push('host-settled'); });
  return { events, sessions, publisher, onTurnReleased, onTurnSettled };
}

function run(
  dependencies = setup(),
  overrides: Partial<Parameters<typeof runAttachedSessionTurn>[0]> = {},
) {
  return runAttachedSessionTurn({
    sessions: dependencies.sessions,
    publisher: dependencies.publisher,
    sessionId,
    turnId,
    executionId,
    action: async () => 'result',
    onTurnReleased: dependencies.onTurnReleased,
    onTurnSettled: dependencies.onTurnSettled,
    ...overrides,
  });
}

describe('runAttachedSessionTurn', () => {
  it('does not expose a createTurn dependency', () => {
    const dependencies = setup();
    expect('createTurn' in dependencies.sessions).toBe(false);
  });

  it('does not expose a createExecution dependency', () => {
    const dependencies = setup();
    expect('createExecution' in dependencies.sessions).toBe(false);
  });

  it('does not expose an acquireInterruptedExecution dependency', () => {
    const dependencies = setup();
    expect('acquireInterruptedExecution' in dependencies.sessions).toBe(false);
  });

  it('uses the supplied Session, Turn, and exact Execution identity', async () => {
    const dependencies = setup({ extraExecutions: [makeExecution('failed', 'execution_decoy')] });

    await run(dependencies);

    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenNthCalledWith(1, sessionId);
    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenNthCalledWith(2, sessionId);
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      turnId,
      artifacts: expect.objectContaining({ turns: [expect.objectContaining({ id: turnId, status: 'completed' })] }),
    });
  });

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'stopped'],
    ['failed', 'failed'],
    ['running', 'failed'],
  ] as const)('settles a normally returned %s Execution as a %s Turn and publishes once', async (executionStatus, turnStatus) => {
    const dependencies = setup({ executionStatus });
    const settledTurn = { ...runningTurn, status: turnStatus, completedAt: '2026-09-25T00:00:01.000Z' };

    const result = await run(dependencies, {
      action: async () => { dependencies.events.push('action'); return 'action-result'; },
    });

    expect(result).toBe('action-result');
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, turnStatus);
    expect(dependencies.publisher.publishAfterSettledTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.onTurnSettled).toHaveBeenCalledExactlyOnceWith(settledTurn, turnStatus);
    expect(dependencies.onTurnReleased).not.toHaveBeenCalled();
    expect(dependencies.events).toEqual([
      'action',
      'reload',
      `settle:${turnId}:${turnStatus}`,
      'reload',
      'publish',
      'host-settled',
    ]);
  });

  it.each([
    ['interrupted', true],
    ['missing', false],
  ] as const)('releases without settlement or publication when normal action leaves %s target', async (state, includeExecution) => {
    const dependencies = setup({
      executionStatus: state === 'missing' ? undefined : state,
      includeExecution,
    });

    await expect(run(dependencies)).resolves.toBe('result');

    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(dependencies.sessions.settleTurn).not.toHaveBeenCalled();
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnReleased).toHaveBeenCalledOnce();
    expect(dependencies.onTurnSettled).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', 'completed'],
    ['cancelled', 'stopped'],
    ['failed', 'failed'],
  ] as const)('settles a thrown action with terminal %s Execution as a %s Turn without publishing', async (executionStatus, turnStatus) => {
    const dependencies = setup({ executionStatus });
    const actionError = new Error('resume action failed');
    const settledTurn = { ...runningTurn, status: turnStatus, completedAt: '2026-09-25T00:00:01.000Z' };

    await expect(run(dependencies, {
      action: async () => { dependencies.events.push('action'); throw actionError; },
    })).rejects.toBe(actionError);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, turnStatus);
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnSettled).toHaveBeenCalledExactlyOnceWith(settledTurn, turnStatus);
    expect(dependencies.onTurnReleased).not.toHaveBeenCalled();
    expect(dependencies.events).toEqual(['action', 'reload', `settle:${turnId}:${turnStatus}`, 'host-settled']);
  });

  it.each([
    ['interrupted', true],
    ['running', true],
    ['missing', false],
  ] as const)('releases and rethrows when action fails with %s target', async (state, includeExecution) => {
    const dependencies = setup({
      executionStatus: state === 'missing' ? undefined : state,
      includeExecution,
    });
    const actionError = new Error('resume validation failed');

    await expect(run(dependencies, { action: async () => { throw actionError; } })).rejects.toBe(actionError);

    expect(dependencies.sessions.settleTurn).not.toHaveBeenCalled();
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnReleased).toHaveBeenCalledOnce();
    expect(dependencies.onTurnSettled).not.toHaveBeenCalled();
  });

  it('reconciles again after an initial normal-path artifact reload failure', async () => {
    const dependencies = setup();
    const error = new Error('artifact reload failed');
    const readArtifacts = vi.mocked(dependencies.sessions.getSessionArtifacts).getMockImplementation();
    vi.mocked(dependencies.sessions.getSessionArtifacts)
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(readArtifacts!);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnSettled).toHaveBeenCalledOnce();
    expect(dependencies.onTurnReleased).not.toHaveBeenCalled();
  });

  it('reconciles a failed normal-path Turn settlement using the outer catch', async () => {
    const dependencies = setup();
    const error = new Error('Turn settlement failed');
    vi.mocked(dependencies.sessions.settleTurn).mockRejectedValueOnce(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledTimes(2);
    expect(dependencies.sessions.settleTurn).toHaveBeenNthCalledWith(1, turnId, 'completed');
    expect(dependencies.sessions.settleTurn).toHaveBeenNthCalledWith(2, turnId, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnSettled).toHaveBeenCalledOnce();
    expect(dependencies.events).toEqual([
      'reload',
      'reload',
      `settle:${turnId}:completed`,
      'host-settled',
    ]);
  });

  it('releases once after publication fails following canonical settlement', async () => {
    const dependencies = setup();
    const error = new Error('WorkingContext publication failed');
    vi.mocked(dependencies.publisher.publishAfterSettledTurn).mockRejectedValue(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).toHaveBeenCalledOnce();
    expect(dependencies.onTurnSettled).not.toHaveBeenCalled();
    expect(dependencies.onTurnReleased).toHaveBeenCalledOnce();
    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledTimes(3);
  });

  it('releases once when settled-artifact reload fails after canonical settlement', async () => {
    const dependencies = setup();
    const error = new Error('settled artifact reload failed');
    const readArtifacts = vi.mocked(dependencies.sessions.getSessionArtifacts).getMockImplementation();
    vi.mocked(dependencies.sessions.getSessionArtifacts)
      .mockImplementationOnce(readArtifacts!)
      .mockRejectedValueOnce(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, 'completed');
    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledTimes(3);
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnSettled).not.toHaveBeenCalled();
    expect(dependencies.onTurnReleased).toHaveBeenCalledOnce();
  });

  it('reconciles a failed normal-path host release callback through the outer catch', async () => {
    const dependencies = setup({ executionStatus: 'interrupted' });
    const error = new Error('host release failed');
    dependencies.onTurnReleased.mockRejectedValueOnce(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.onTurnReleased).toHaveBeenCalledTimes(2);
    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledTimes(2);
    expect(dependencies.sessions.settleTurn).not.toHaveBeenCalled();
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
  });

  it('does not re-enter reconciliation when release fails inside the action-failure catch', async () => {
    const dependencies = setup({ executionStatus: 'running' });
    const error = new Error('host release failed');
    dependencies.onTurnReleased.mockRejectedValue(error);

    await expect(run(dependencies, { action: async () => { throw new Error('action failed'); } })).rejects.toBe(error);

    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledOnce();
    expect(dependencies.sessions.settleTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnReleased).toHaveBeenCalledOnce();
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
  });

  it('propagates host settled callback failures after canonical settlement without settling twice', async () => {
    const dependencies = setup();
    const error = new Error('host projection failed');
    dependencies.onTurnSettled.mockRejectedValue(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledExactlyOnceWith(turnId, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).toHaveBeenCalledOnce();
    expect(dependencies.onTurnSettled).toHaveBeenCalledOnce();
    expect(dependencies.onTurnReleased).toHaveBeenCalledOnce();
    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledTimes(3);
  });

  it('propagates artifact reload failure on the action-failure path', async () => {
    const dependencies = setup();
    const reloadError = new Error('artifact reload failed');
    vi.mocked(dependencies.sessions.getSessionArtifacts).mockRejectedValue(reloadError);

    await expect(run(dependencies, { action: async () => { throw new Error('action failed'); } })).rejects.toBe(reloadError);

    expect(dependencies.sessions.getSessionArtifacts).toHaveBeenCalledExactlyOnceWith(sessionId);
    expect(dependencies.sessions.settleTurn).not.toHaveBeenCalled();
    expect(dependencies.onTurnReleased).not.toHaveBeenCalled();
  });
});
