import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgeExecutionProfile } from '@harness/command-judge';
import type { ResearchExecution, ResearchSessionStore } from '@harness/session-core';
import {
  JudgeExecutionCompletionError,
  type CompletedJudgeExecution,
} from '../src/judge/executionCompletion.js';
import {
  JudgeExecutionPreparationError,
  prepareJudgeExecution,
  type JudgeExecutionPreparationOptions,
  type PreparedJudgeExecution,
} from '../src/judge/executionPreparation.js';
import { runJudgeWorkflowRuntime, type JudgeWorkflowRuntimeResult } from '../src/judge/workflowRuntime.js';
import {
  JudgeExecutionSettlementError,
  runJudgeExecutionLifecycle,
  type JudgeExecutionLifecycleOptions,
} from '@harness/engine';

const authorities = vi.hoisted(() => ({
  prepare: vi.fn(),
  runtime: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../src/judge/executionPreparation.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/judge/executionPreparation.js')>();
  return { ...actual, prepareJudgeExecution: authorities.prepare };
});

vi.mock('../src/judge/workflowRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/judge/workflowRuntime.js')>();
  return { ...actual, runJudgeWorkflowRuntime: authorities.runtime };
});

vi.mock('../src/judge/executionCompletion.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/judge/executionCompletion.js')>();
  return { ...actual, completeJudgeExecution: authorities.complete };
});

const execution: ResearchExecution = {
  id: 'execution-lifecycle',
  sessionId: 'session-lifecycle',
  turnId: 'turn-lifecycle',
  attempt: 1,
  ticker: 'BBCA',
  command: 'judge',
  status: 'running',
  executionTime: null,
  error: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  completedAt: null,
  resumeGeneration: 0,
};
const profile = {
  executionId: execution.id,
  ticker: execution.ticker,
  workflowId: 'judge',
  command: 'judge',
  fingerprint: 'profile-fingerprint',
} as unknown as JudgeExecutionProfile;
const runtimeResult = {} as JudgeWorkflowRuntimeResult;
const completedExecution = {
  ...execution,
  status: 'completed',
  completedAt: '2026-09-28T00:01:00.000Z',
} satisfies ResearchExecution;
const completed: CompletedJudgeExecution = { execution: completedExecution, artifacts: [] };
const freshPrepared: PreparedJudgeExecution = {
  execution,
  profile,
  reasoning: false,
  conditional: false,
  researchers: { market: false, news: false },
};

function fixture(): {
  params: JudgeExecutionLifecycleOptions;
  settleExecution: ReturnType<typeof vi.fn<ResearchSessionStore['settleExecution']>>;
  known: ReturnType<typeof vi.fn>;
} {
  const settleExecution = vi.fn<ResearchSessionStore['settleExecution']>(async (_id, status, result) => ({
    ...execution,
    status,
    error: result?.error ?? null,
    executionTime: result?.executionTimeSeconds ?? null,
    completedAt: result?.completedAt ?? '2026-09-28T00:01:00.000Z',
  }));
  const sessions = { settleExecution };
  const preparation = {
    sessions: {
      createExecution: vi.fn(),
      getSessionArtifacts: vi.fn(),
      acquireInterruptedExecution: vi.fn(),
    },
    executionProfiles: {} as never,
    checkpointStores: {} as never,
    lifecycle: { sessionId: execution.sessionId, turnId: execution.turnId },
    request: { ticker: execution.ticker, command: 'judge', researchers: { market: false, news: false } },
    currentRuntime: { provider: 'test', model: 'test', capabilityPlan: {} as never },
  } satisfies JudgeExecutionPreparationOptions;
  const known = vi.fn();
  return {
    settleExecution,
    known,
    params: {
      preparation,
      runtime: {
        dependencies: { node: {} as never, trace: {} as never },
        progress: () => undefined,
        projectionRepairStores: {} as never,
      },
      completion: {
        sessions,
        releaseStores: {} as never,
        historicalArtifactStores: {} as never,
      },
      onExecutionKnown: known,
    },
  };
}

beforeEach(() => {
  authorities.prepare.mockReset().mockResolvedValue(freshPrepared);
  authorities.runtime.mockReset().mockResolvedValue(runtimeResult);
  authorities.complete.mockReset().mockResolvedValue(completed);
});

describe('runJudgeExecutionLifecycle', () => {
  it('composes fresh preparation, runtime, and completion in order and settles completed once', async () => {
    const f = fixture();
    const order: string[] = [];
    authorities.prepare.mockImplementation(async () => { order.push('prepare'); return freshPrepared; });
    authorities.runtime.mockImplementation(async () => { order.push('runtime'); return runtimeResult; });
    authorities.complete.mockImplementation(async params => {
      order.push('complete');
      await params.sessions.settleExecution(execution.id, 'completed', { executionTimeSeconds: 1 });
      return completed;
    });

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(order).toEqual(['prepare', 'runtime', 'complete']);
    expect(f.settleExecution).toHaveBeenCalledOnce();
    expect(f.settleExecution).toHaveBeenCalledWith(execution.id, 'completed', { executionTimeSeconds: 1 });
    expect(authorities.runtime).toHaveBeenCalledOnce();
    expect(authorities.complete).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ outcome: 'completed', execution: completedExecution, runtime: runtimeResult, artifacts: [] });
  });

  it('settles a fresh preparation failure after notifying the host of the created Execution', async () => {
    const f = fixture();
    const preparationCause = new Error('profile store unavailable');
    const order: string[] = [];
    f.known.mockImplementation(() => { order.push('known'); });
    f.settleExecution.mockImplementation(async (_id, status) => {
      order.push('settle');
      return { ...execution, status, completedAt: '2026-09-28T00:01:00.000Z' };
    });
    authorities.prepare.mockRejectedValue(new JudgeExecutionPreparationError(execution, preparationCause));

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(order).toEqual(['known', 'settle']);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: preparationCause.message });
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'failed', execution: { id: execution.id, status: 'failed' }, cause: preparationCause });
  });

  it('leaves resume incompatibility before acquisition and settlement', async () => {
    const f = fixture();
    const incompatibility = new Error('checkpoint mismatch');
    f.params.preparation.request.resumeExecutionId = execution.id;
    authorities.prepare.mockRejectedValue(incompatibility);

    await expect(runJudgeExecutionLifecycle(f.params)).rejects.toBe(incompatibility);

    expect(f.settleExecution).not.toHaveBeenCalled();
    expect(f.known).not.toHaveBeenCalled();
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(authorities.complete).not.toHaveBeenCalled();
  });

  it('passes the same acquired resume Execution and plan to runtime without creating a replacement', async () => {
    const f = fixture();
    const resumed = { ...execution, resumeGeneration: 4 };
    const resumePlan = { profile, restored: [], outputs: [], reasoning: false, conditional: false, researchers: { market: false, news: false } };
    authorities.prepare.mockResolvedValue({ ...freshPrepared, execution: resumed, resumePlan });

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(f.params.preparation.sessions.createExecution).not.toHaveBeenCalled();
    expect(authorities.runtime).toHaveBeenCalledWith(expect.objectContaining({
      run: { id: resumed.id, ticker: resumed.ticker, createdAt: resumed.createdAt },
      canonical: expect.objectContaining({ execution: resumed, profile }),
      resumePlan,
    }));
    expect(authorities.complete).toHaveBeenCalledWith(expect.objectContaining({ execution: resumed, profile }));
    expect(result).toMatchObject({ outcome: 'completed', execution: completedExecution });
  });

  it('uses reasoning, conditional, and researcher settings resolved by preparation', async () => {
    const f = fixture();
    const researchers = { market: true, news: true };
    authorities.prepare.mockResolvedValue({ ...freshPrepared, reasoning: true, conditional: true, researchers });

    await runJudgeExecutionLifecycle(f.params);

    expect(authorities.runtime).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: true,
      conditional: true,
      dependencies: expect.objectContaining({ node: expect.objectContaining({ researchers }) }),
    }));
  });

  it('settles a runtime failure failed exactly once and keeps the action cause', async () => {
    const f = fixture();
    const actionCause = new Error('workflow failed');
    authorities.runtime.mockRejectedValue(actionCause);

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: actionCause.message });
    expect(authorities.complete).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: 'failed', cause: actionCause });
  });

  it('settles an aborted runtime as cancelled, not failed', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const abortCause = new Error('aborted');
    f.params.runtime.signal = controller.signal;
    authorities.runtime.mockRejectedValue(abortCause);

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'cancelled', { error: 'Aborted' });
    expect(result).toMatchObject({ outcome: 'cancelled', cause: abortCause });
  });

  it('uses the host abort classifier when the signal is not aborted', async () => {
    const f = fixture();
    const abortCause = new Error('host abort');
    const params: JudgeExecutionLifecycleOptions = {
      ...f.params,
      isAbortError: cause => cause === abortCause,
    };
    authorities.runtime.mockRejectedValue(abortCause);

    const result = await runJudgeExecutionLifecycle(params);

    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'cancelled', { error: abortCause.message });
    expect(result).toMatchObject({ outcome: 'cancelled', cause: abortCause });
  });

  it('settles a completion failure before settlement through the normal failure path', async () => {
    const f = fixture();
    const completionCause = new Error('release validation failed');
    authorities.complete.mockRejectedValue(new JudgeExecutionCompletionError('before-settlement', completionCause));

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: completionCause.message });
    expect(result).toMatchObject({ outcome: 'failed', cause: completionCause });
  });

  it('keeps a post-settlement publication failure completed and preserves its cause', async () => {
    const f = fixture();
    const publicationCause = new Error('artifact publication failed');
    authorities.complete.mockRejectedValue(new JudgeExecutionCompletionError('after-settlement', publicationCause, completedExecution));

    const result = await runJudgeExecutionLifecycle(f.params);

    expect(f.settleExecution).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: 'completed-publication-failed',
      execution: completedExecution,
      runtime: runtimeResult,
      cause: publicationCause,
    });
  });

  it('preserves the action and settlement causes when failed/cancelled settlement persistence fails', async () => {
    const f = fixture();
    const actionCause = new Error('runtime failed');
    const settlementCause = new Error('database unavailable');
    authorities.runtime.mockRejectedValue(actionCause);
    f.settleExecution.mockRejectedValue(settlementCause);

    const error = await runJudgeExecutionLifecycle(f.params).catch(cause => cause);

    expect(error).toBeInstanceOf(JudgeExecutionSettlementError);
    expect(error).toMatchObject({ execution, intendedStatus: 'failed', actionCause, settlementCause });
    expect(f.settleExecution).toHaveBeenCalledOnce();
  });

  it('keeps host implementation dependencies out of the lifecycle coordinator', () => {
    const source = readFileSync(new URL('../src/judge/executionLifecycle.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s+['"][^'"]*(?:apps\/cli|@harness\/(?:database|financial-data|llm|providers?|config)|packages\/database|node:fs|(?:node:)?fs(?:\/|['"]))/i);
    expect(source).not.toMatch(/\b(?:FinharnessDatabase|HarnessContext|AgentEvent|UserFriendlyError|ConversationController|mapToUserFriendly)\b/i);
  });
});
