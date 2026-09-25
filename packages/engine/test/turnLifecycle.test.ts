import { describe, expect, it, vi } from 'vitest';
import type {
  ResearchExecution,
  ResearchSessionArtifacts,
  ResearchSessionStore,
  ResearchTurn,
} from '@harness/session-core';
import { runSessionTurn, type WorkingContextPublisher } from '../src/index.js';

const runningTurn: ResearchTurn = {
  id: 'turn_1',
  sessionId: 'session_1',
  runId: null,
  input: 'question',
  command: 'conversation',
  status: 'running',
  startedAt: '2026-09-25T00:00:00.000Z',
  completedAt: null,
};

const sessionArtifacts = (executions: ResearchExecution[] = []): ResearchSessionArtifacts => ({
  session: {
    id: 'session_1', title: 'Session', provider: 'mock', model: 'mock',
    reasoningMode: 'usual', createdAt: runningTurn.startedAt, updatedAt: runningTurn.startedAt,
  },
  turns: [runningTurn],
  executions,
  steps: [],
  modelCalls: [],
});

function execution(status: ResearchExecution['status'], id = `execution_${status}`): ResearchExecution {
  return {
    id,
    sessionId: runningTurn.sessionId,
    turnId: runningTurn.id,
    attempt: 1,
    ticker: 'BBRI',
    command: 'judge',
    status,
    executionTime: null,
    error: null,
    createdAt: runningTurn.startedAt,
    completedAt: status === 'completed' || status === 'failed' || status === 'cancelled' ? runningTurn.startedAt : null,
    resumeGeneration: 1,
  };
}

function lifecycleDependencies(executions: ResearchExecution[] = []) {
  const artifacts = sessionArtifacts(executions);
  const sessions: Pick<ResearchSessionStore, 'createTurn' | 'getSessionArtifacts' | 'settleTurn'> = {
    createTurn: vi.fn(async params => ({ ...runningTurn, ...params })),
    getSessionArtifacts: vi.fn(async () => artifacts),
    settleTurn: vi.fn(async (_turnId, status) => ({
      ...runningTurn,
      status,
      completedAt: '2026-09-25T00:00:01.000Z',
    })),
  };
  const publisher: Pick<WorkingContextPublisher, 'publishAfterSettledTurn'> = {
    publishAfterSettledTurn: vi.fn(async () => ({ status: 'skipped' as const, version: null })),
  };
  return { sessions, publisher, artifacts };
}

function run(dependencies = lifecycleDependencies(), overrides: Partial<Parameters<typeof runSessionTurn>[0]> = {}) {
  return runSessionTurn({
    sessions: dependencies.sessions,
    publisher: dependencies.publisher,
    sessionId: runningTurn.sessionId,
    input: runningTurn.input,
    command: runningTurn.command,
    onTurnStarted: vi.fn(),
    action: vi.fn(async () => 'result'),
    onTurnSettled: vi.fn(),
    ...overrides,
  });
}

describe('runSessionTurn', () => {
  it('creates one fresh Turn', async () => {
    const dependencies = lifecycleDependencies();

    await run(dependencies);

    expect(dependencies.sessions.createTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.createTurn).toHaveBeenCalledWith({
      sessionId: runningTurn.sessionId, input: runningTurn.input, command: runningTurn.command,
    });
  });

  it('calls the start callback after canonical Turn creation', async () => {
    const order: string[] = [];
    const dependencies = lifecycleDependencies();
    vi.mocked(dependencies.sessions.createTurn).mockImplementation(async params => {
      order.push('createTurn');
      return { ...runningTurn, ...params };
    });

    await run(dependencies, { onTurnStarted: turn => { order.push(`started:${turn.id}`); } });

    expect(order).toEqual(['createTurn', 'started:turn_1']);
  });

  it('invokes the action with the created Turn', async () => {
    const action = vi.fn(async () => 'done');

    await run(lifecycleDependencies(), { action });

    expect(action).toHaveBeenCalledWith(expect.objectContaining({ id: runningTurn.id, status: 'running' }));
  });

  it('settles a successful action as completed', async () => {
    const dependencies = lifecycleDependencies();

    await run(dependencies);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
  });

  it('publishes WorkingContext exactly once on normal success', async () => {
    const dependencies = lifecycleDependencies();

    await run(dependencies);

    expect(dependencies.publisher.publishAfterSettledTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.publisher.publishAfterSettledTurn).toHaveBeenCalledWith({
      sessionId: runningTurn.sessionId,
      turnId: runningTurn.id,
      artifacts: dependencies.artifacts,
    });
  });

  it('preserves normal success ordering through host settlement projection', async () => {
    const order: string[] = [];
    const dependencies = lifecycleDependencies();
    vi.mocked(dependencies.sessions.createTurn).mockImplementation(async params => {
      order.push('createTurn');
      return { ...runningTurn, ...params };
    });
    vi.mocked(dependencies.sessions.settleTurn).mockImplementation(async (_id, status) => {
      order.push(`settleTurn:${status}`);
      return { ...runningTurn, status, completedAt: 'settled' };
    });
    vi.mocked(dependencies.publisher.publishAfterSettledTurn).mockImplementation(async () => {
      order.push('publishAfterSettledTurn');
      return { status: 'skipped', version: null };
    });

    await run(dependencies, {
      onTurnStarted: () => { order.push('onTurnStarted'); },
      action: async () => { order.push('action'); return 'result'; },
      onTurnSettled: () => { order.push('onTurnSettled'); },
    });

    expect(order).toEqual([
      'createTurn', 'onTurnStarted', 'action', 'settleTurn:completed',
      'publishAfterSettledTurn', 'onTurnSettled',
    ]);
  });

  it('settles an ordinary thrown error as failed when there are no Executions', async () => {
    const dependencies = lifecycleDependencies();

    await expect(run(dependencies, { action: async () => { throw new Error('action failed'); } })).rejects.toThrow('action failed');

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'failed');
  });

  it('supports fixed failed settlement for host-local input callbacks', async () => {
    const dependencies = lifecycleDependencies([execution('completed')]);
    vi.mocked(dependencies.sessions.getSessionArtifacts).mockRejectedValue(new Error('failure resolver must not run'));

    await expect(run(dependencies, {
      failureStatus: 'failed',
      action: async () => { throw new Error('local projection failed'); },
    })).rejects.toThrow('local projection failed');

    expect(dependencies.sessions.getSessionArtifacts).not.toHaveBeenCalled();
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'failed');
  });

  it('settles an aborted signal as stopped', async () => {
    const dependencies = lifecycleDependencies();
    const controller = new AbortController();
    controller.abort();

    await expect(run(dependencies, { signal: controller.signal, action: async () => { throw new Error('cancel'); } })).rejects.toThrow('cancel');

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'stopped');
  });

  it('settles a host-classified abort error as stopped', async () => {
    const dependencies = lifecycleDependencies();
    const error = { code: 'ABORTED' };

    await expect(run(dependencies, {
      isAbortError: candidate => candidate === error,
      action: async () => { throw error; },
    })).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'stopped');
  });

  it('lets a completed child Execution win over abort and failure outcomes', async () => {
    const dependencies = lifecycleDependencies([
      execution('failed', 'execution_failed'), execution('completed', 'execution_completed'),
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(run(dependencies, {
      signal: controller.signal,
      isAbortError: () => true,
      action: async () => { throw new Error('later action failed'); },
    })).rejects.toThrow('later action failed');

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
  });

  it('lets a cancelled child Execution win over a failed child Execution', async () => {
    const dependencies = lifecycleDependencies([execution('failed'), execution('cancelled')]);

    await expect(run(dependencies, { action: async () => { throw new Error('action failed'); } })).rejects.toThrow('action failed');

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'stopped');
  });

  it('settles from a failed child Execution when no completed or cancelled child exists', async () => {
    const dependencies = lifecycleDependencies([execution('failed')]);

    await expect(run(dependencies, { action: async () => { throw new Error('action failed'); } })).rejects.toThrow('action failed');

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'failed');
  });

  it('does not publish a completed Turn that was settled through the failure path', async () => {
    const dependencies = lifecycleDependencies([execution('completed')]);

    await expect(run(dependencies, { action: async () => { throw new Error('action failed after execution'); } }))
      .rejects.toThrow('action failed after execution');

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
  });

  it('rethrows the original action error after completing failure settlement and projection', async () => {
    const dependencies = lifecycleDependencies();
    const error = new Error('original action error');
    const onTurnSettled = vi.fn();

    await expect(run(dependencies, {
      action: async () => { throw error; },
      onTurnSettled,
    })).rejects.toBe(error);

    expect(onTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('runs failure projection before canonical Turn settlement', async () => {
    const order: string[] = [];
    const dependencies = lifecycleDependencies();
    vi.mocked(dependencies.sessions.settleTurn).mockImplementation(async (_id, status) => {
      order.push(`settle:${status}`);
      return { ...runningTurn, status, completedAt: 'settled' };
    });

    await expect(run(dependencies, {
      action: async () => { throw new Error('response failed'); },
      onTurnFailure: (_turn, status) => { order.push(`failure:${status}`); },
    })).rejects.toThrow('response failed');

    expect(order).toEqual(['failure:failed', 'settle:failed']);
  });

  it('propagates createTurn store failures', async () => {
    const dependencies = lifecycleDependencies();
    const error = new Error('create failed');
    vi.mocked(dependencies.sessions.createTurn).mockRejectedValue(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).not.toHaveBeenCalled();
  });

  it('propagates Session artifact read failures after canonical completion without re-settling', async () => {
    const dependencies = lifecycleDependencies();
    const error = new Error('artifact read failed');
    vi.mocked(dependencies.sessions.getSessionArtifacts).mockRejectedValue(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
  });

  it('propagates failure settlement store errors', async () => {
    const dependencies = lifecycleDependencies();
    const error = new Error('settlement failed');
    vi.mocked(dependencies.sessions.settleTurn).mockRejectedValue(error);

    await expect(run(dependencies, { action: async () => { throw new Error('action failed'); } })).rejects.toBe(error);

    expect(dependencies.publisher.publishAfterSettledTurn).not.toHaveBeenCalled();
  });

  it('does not settle a completed Turn twice when publication fails', async () => {
    const dependencies = lifecycleDependencies();
    const error = new Error('publication failed');
    vi.mocked(dependencies.publisher.publishAfterSettledTurn).mockRejectedValue(error);

    await expect(run(dependencies)).rejects.toBe(error);

    expect(dependencies.sessions.settleTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
  });

  it('completes a natural-language Turn with zero Executions', async () => {
    const dependencies = lifecycleDependencies();

    await run(dependencies, { command: 'conversation', input: 'how is BBRI doing?' });

    expect(dependencies.sessions.createTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
    expect(dependencies.artifacts.executions).toEqual([]);
  });

  it('completes a local-input Turn with zero Executions', async () => {
    const dependencies = lifecycleDependencies();

    await run(dependencies, { command: 'help', input: '/help', action: async () => undefined });

    expect(dependencies.sessions.createTurn).toHaveBeenCalledTimes(1);
    expect(dependencies.sessions.settleTurn).toHaveBeenCalledWith(runningTurn.id, 'completed');
    expect(dependencies.artifacts.executions).toEqual([]);
  });
});
