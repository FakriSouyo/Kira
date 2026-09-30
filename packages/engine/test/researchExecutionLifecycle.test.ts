import { readFileSync } from 'node:fs';
import { WorkflowStepError } from '@harness/command-core';
import type { ResearchReportPayload } from '@harness/schemas';
import type {
  ResearchExecution,
  ResearchReportArtifact,
  ResearchReportPublication,
  ResearchReportPublicationStore,
  ResearchSessionStore,
} from '@harness/session-core';
import {
  runResearchExecutionLifecycle as publicRunResearchExecutionLifecycle,
} from '@harness/engine';
import {
  ResearchExecutionSettlementError,
  runResearchExecutionLifecycle,
} from '../src/research/executionLifecycle.js';
import type {
  ResearchExecutionLifecycleOptions,
} from '../src/research/executionLifecycle.js';
import type {
  ResearchWorkflowRuntimeOptions,
  ResearchWorkflowRuntimeResult,
} from '../src/research/workflowRuntime.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authorities = vi.hoisted(() => ({ runtime: vi.fn() }));

vi.mock('../src/research/workflowRuntime.js', () => ({
  runResearchWorkflowRuntime: authorities.runtime,
}));

const question = 'Assess the quality of BBCA revenue growth.';
const report: ResearchReportPayload = {
  question,
  summary: 'Revenue growth is supported by a primary company filing.',
  findings: [],
  sourceAssessments: [],
  gaps: [],
  coverage: [],
};
const execution: ResearchExecution = {
  id: 'execution-research-lifecycle',
  sessionId: 'session-research-lifecycle',
  turnId: 'turn-research-lifecycle',
  attempt: 1,
  ticker: 'BBCA',
  command: 'research',
  status: 'running',
  executionTime: null,
  error: null,
  createdAt: '2026-09-28T00:00:00.000Z',
  completedAt: null,
  resumeGeneration: 0,
};
const completedExecution: ResearchExecution = {
  ...execution,
  status: 'completed',
  completedAt: '2026-09-28T00:01:00.000Z',
};
const artifact: ResearchReportArtifact = {
  artifactId: `artifact_research_report_${execution.id}`,
  kind: 'RESEARCH_REPORT',
  schemaVersion: 1,
  sessionId: execution.sessionId,
  turnId: execution.turnId,
  executionId: execution.id,
  ticker: execution.ticker,
  payload: report,
  createdAt: completedExecution.completedAt!,
};
const runtimeResult: ResearchWorkflowRuntimeResult = {
  acquisition: {} as ResearchWorkflowRuntimeResult['acquisition'],
  grounded: {} as ResearchWorkflowRuntimeResult['grounded'],
  report,
};
const publicationResult: ResearchReportPublication = { execution: completedExecution, artifact };

function fixture(): {
  params: ResearchExecutionLifecycleOptions;
  createExecution: ReturnType<typeof vi.fn<ResearchSessionStore['createExecution']>>;
  settleExecution: ReturnType<typeof vi.fn<ResearchSessionStore['settleExecution']>>;
  completeAndPublish: ReturnType<typeof vi.fn<ResearchReportPublicationStore['completeAndPublish']>>;
  known: ReturnType<typeof vi.fn>;
} {
  const createExecution = vi.fn<ResearchSessionStore['createExecution']>(async input => ({
    ...execution,
    sessionId: input.sessionId,
    turnId: input.turnId,
    ticker: input.ticker,
    command: input.command,
  }));
  const settleExecution = vi.fn<ResearchSessionStore['settleExecution']>(async (_id, status, result) => ({
    ...execution,
    status,
    error: result?.error ?? null,
    executionTime: result?.executionTimeSeconds ?? null,
    completedAt: result?.completedAt ?? '2026-09-28T00:01:00.000Z',
  }));
  const completeAndPublish = vi.fn<ResearchReportPublicationStore['completeAndPublish']>(async () => publicationResult);
  const known = vi.fn();
  const params: ResearchExecutionLifecycleOptions = {
    lifecycle: {
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      ticker: execution.ticker,
      question,
    },
    sessions: { createExecution, settleExecution },
    publication: { completeAndPublish },
    runtime: { dependencies: {} as never },
    onExecutionKnown: known,
  };
  return { params, createExecution, settleExecution, completeAndPublish, known };
}

beforeEach(() => {
  authorities.runtime.mockReset().mockResolvedValue(runtimeResult);
});

describe('runResearchExecutionLifecycle', () => {
  it('exports the lifecycle publicly and orders creation, notification, runtime, and atomic publication', async () => {
    expect(publicRunResearchExecutionLifecycle).toBe(runResearchExecutionLifecycle);
    const f = fixture();
    const order: string[] = [];
    let createdExecution: ResearchExecution | undefined;
    f.createExecution.mockImplementation(async input => {
      order.push('createExecution');
      createdExecution = { ...execution, sessionId: input.sessionId, turnId: input.turnId, ticker: input.ticker, command: input.command };
      return createdExecution;
    });
    f.params.onExecutionKnown = async knownExecution => {
      order.push('onExecutionKnown');
      expect(knownExecution).toBe(createdExecution);
    };
    authorities.runtime.mockImplementation(async (options: ResearchWorkflowRuntimeOptions) => {
      order.push('runtime');
      expect(options).toMatchObject({ run: { id: execution.id, ticker: execution.ticker }, question });
      expect(options.dependencies).toBe(f.params.runtime.dependencies);
      return runtimeResult;
    });
    f.completeAndPublish.mockImplementation(async input => {
      order.push('completeAndPublish');
      expect(input.executionId).toBe(execution.id);
      expect(input.payload).toBe(runtimeResult.report);
      expect(Number.isFinite(input.executionTimeSeconds)).toBe(true);
      expect(input.executionTimeSeconds).toBeGreaterThanOrEqual(0);
      return publicationResult;
    });

    const result = await runResearchExecutionLifecycle(f.params);

    expect(order).toEqual(['createExecution', 'onExecutionKnown', 'runtime', 'completeAndPublish']);
    expect(f.createExecution).toHaveBeenCalledExactlyOnceWith({
      sessionId: execution.sessionId,
      turnId: execution.turnId,
      ticker: 'BBCA',
      command: 'research',
    });
    expect(authorities.runtime).toHaveBeenCalledOnce();
    expect(f.completeAndPublish).toHaveBeenCalledOnce();
    expect(f.settleExecution).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'completed', execution: completedExecution, runtime: runtimeResult, artifact });
  });

  it.each([
    ['ticker', { ticker: '   ' }],
    ['question', { question: ' \t ' }],
  ] as const)('rejects a blank %s before calling any authority', async (_field, invalid) => {
    const f = fixture();
    await expect(runResearchExecutionLifecycle({
      ...f.params,
      lifecycle: { ...f.params.lifecycle, ...invalid },
    })).rejects.toThrow();
    expect(f.createExecution).not.toHaveBeenCalled();
    expect(f.known).not.toHaveBeenCalled();
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).not.toHaveBeenCalled();
  });

  it('propagates createExecution failure without notifying, running, publishing, or settling', async () => {
    const f = fixture();
    const creationCause = new Error('Execution store unavailable');
    f.createExecution.mockRejectedValue(creationCause);
    await expect(runResearchExecutionLifecycle(f.params)).rejects.toBe(creationCause);
    expect(f.known).not.toHaveBeenCalled();
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).not.toHaveBeenCalled();
  });

  it('settles a notification failure and skips runtime and publication', async () => {
    const f = fixture();
    const cause = new Error('Host could not record Execution identity');
    f.known.mockRejectedValue(cause);
    const result = await runResearchExecutionLifecycle(f.params);
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', execution: { id: execution.id, status: 'failed' }, cause });
  });

  it('settles a runtime failure once and preserves its cause', async () => {
    const f = fixture();
    const cause = new Error('Research workflow failed');
    authorities.runtime.mockRejectedValue(cause);
    const result = await runResearchExecutionLifecycle(f.params);
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', cause, execution: { id: execution.id, status: 'failed' } });
  });

  it('settles WorkflowStepError with its underlying cause', async () => {
    const f = fixture();
    const cause = new Error('Provider returned an invalid response');
    const wrapper = new WorkflowStepError('research', 'acquire-company', 'Workflow step failed', { cause });
    authorities.runtime.mockRejectedValue(wrapper);
    const result = await runResearchExecutionLifecycle(f.params);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', cause });
  });

  it('settles an aborted signal as cancelled with the canonical error text', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    f.params.runtime.signal = controller.signal;
    const cause = new Error('runtime observed abort');
    authorities.runtime.mockRejectedValue(cause);
    const result = await runResearchExecutionLifecycle(f.params);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'cancelled', { error: 'Aborted' });
    expect(result).toMatchObject({ outcome: 'cancelled', cause });
  });

  it('uses the host abort classifier when the signal is not aborted', async () => {
    const f = fixture();
    const cause = new Error('Host cancelled Research');
    f.params.isAbortError = error => error === cause;
    authorities.runtime.mockRejectedValue(cause);
    const result = await runResearchExecutionLifecycle(f.params);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'cancelled', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'cancelled', cause });
  });

  it('settles atomic publication failure and does not retry or return a partial-success outcome', async () => {
    const f = fixture();
    const cause = new Error('Atomic Research publication failed');
    f.completeAndPublish.mockRejectedValue(cause);
    const result = await runResearchExecutionLifecycle(f.params);
    expect(f.completeAndPublish).toHaveBeenCalledOnce();
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', cause });
  });

  it('preserves action and terminal settlement persistence failures', async () => {
    const f = fixture();
    const actionCause = new Error('Research runtime failed');
    const settlementCause = new Error('Execution store unavailable during settlement');
    authorities.runtime.mockRejectedValue(actionCause);
    f.settleExecution.mockRejectedValue(settlementCause);
    const error = await runResearchExecutionLifecycle(f.params).catch(cause => cause);
    expect(error).toBeInstanceOf(ResearchExecutionSettlementError);
    expect(error).toMatchObject({
      execution,
      intendedStatus: 'failed',
      actionCause,
      settlementCause,
    });
    expect((error as Error).cause).toBe(settlementCause);
  });

  it('rejects terminal settlement responses with the wrong identity or status', async () => {
    const actionCause = new Error('Research runtime failed');
    for (const settled of [
      { ...execution, id: 'different-execution', status: 'failed' as const },
      { ...execution, status: 'running' as const },
    ]) {
      const f = fixture();
      authorities.runtime.mockRejectedValue(actionCause);
      f.settleExecution.mockResolvedValue(settled);
      const error = await runResearchExecutionLifecycle(f.params).catch(cause => cause);
      expect(error).toBeInstanceOf(ResearchExecutionSettlementError);
      expect(error).toMatchObject({ execution, intendedStatus: 'failed', actionCause });
      expect(error.settlementCause).toBeInstanceOf(Error);
    }
  });

  it('keeps host, persistence, context, resume, checkpoint, and filesystem concerns out of Engine', () => {
    const source = readFileSync(new URL('../src/research/executionLifecycle.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:apps\/cli|@harness\/database|packages\/database|FinharnessDatabase|HarnessContext|ConversationController|UserFriendlyError|WorkingContextPublisher|runSessionTurn|createTurn|settleTurn|ExecutionProfileStore|acquireInterruptedExecution|checkpoint|resume planner|node:fs)/i);
  });
});
