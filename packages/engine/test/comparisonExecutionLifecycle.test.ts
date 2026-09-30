import { readFileSync } from 'node:fs';
import { WorkflowStepError } from '@harness/command-core';
import type { ComparisonMatrix, ComparisonReportPayload } from '@harness/schemas';
import type {
  ComparisonReportArtifact,
  ComparisonReportPublication,
  ComparisonReportPublicationStore,
  ResearchExecution,
  ResearchSessionStore,
} from '@harness/session-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComparisonExecutionSettlementError,
  runComparisonExecutionLifecycle,
} from '../src/index.js';
import { normalizeComparisonSubjects } from '../src/compare/subjects.js';
import type { ComparisonWorkflowRuntimeOptions, ComparisonWorkflowRuntimeResult } from '../src/compare/workflowRuntime.js';
import type { ComparisonExecutionLifecycleOptions } from '../src/compare/executionLifecycle.js';

const authorities = vi.hoisted(() => ({ runtime: vi.fn() }));

vi.mock('../src/compare/workflowRuntime.js', () => ({
  runComparisonWorkflowRuntime: authorities.runtime,
}));

const report = { subjects: [] } as unknown as ComparisonReportPayload;
const execution: ResearchExecution = {
  id: 'execution-compare-lifecycle',
  sessionId: 'session-compare-lifecycle',
  turnId: 'turn-compare-lifecycle',
  attempt: 1,
  ticker: 'BBCA',
  command: 'compare',
  status: 'running',
  executionTime: null,
  error: null,
  createdAt: '2026-09-29T00:00:00.000Z',
  completedAt: null,
  resumeGeneration: 0,
};
const completedExecution: ResearchExecution = { ...execution, status: 'completed', completedAt: '2026-09-29T00:01:00.000Z' };
const artifact = {
  artifactId: `artifact_comparison_report_${execution.id}`,
  kind: 'COMPARISON_REPORT',
  schemaVersion: 1,
  sessionId: execution.sessionId,
  turnId: execution.turnId,
  executionId: execution.id,
  ticker: execution.ticker,
  payload: report,
  createdAt: completedExecution.completedAt,
} as ComparisonReportArtifact;
const runtimeResult: ComparisonWorkflowRuntimeResult = {
  acquisition: { evidence: [], sources: [] },
  matrix: report as ComparisonMatrix,
  report,
};
const publicationResult: ComparisonReportPublication = { execution: completedExecution, artifact };

function fixture(): {
  params: ComparisonExecutionLifecycleOptions;
  createExecution: ReturnType<typeof vi.fn<ResearchSessionStore['createExecution']>>;
  settleExecution: ReturnType<typeof vi.fn<ResearchSessionStore['settleExecution']>>;
  completeAndPublish: ReturnType<typeof vi.fn<ComparisonReportPublicationStore['completeAndPublish']>>;
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
    completedAt: '2026-09-29T00:01:00.000Z',
  }));
  const completeAndPublish = vi.fn<ComparisonReportPublicationStore['completeAndPublish']>(async () => publicationResult);
  const known = vi.fn();
  const params: ComparisonExecutionLifecycleOptions = {
    lifecycle: { sessionId: execution.sessionId, turnId: execution.turnId, subjects: ['bbca', 'bbri'] },
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

describe('normalizeComparisonSubjects', () => {
  it('returns a fresh ordered array with trimmed uppercase IDX tickers', () => {
    const inputs = [' bbca ', 'BbRi', ' bmri'];
    const subjects = normalizeComparisonSubjects(inputs);
    expect(subjects).toEqual(['BBCA', 'BBRI', 'BMRI']);
    expect(subjects).not.toBe(inputs);
  });

  it.each([
    ['not an array', null],
    ['too few subjects', ['BBCA']],
    ['too many subjects', ['BBCA', 'BBRI', 'BMRI', 'ADRO']],
    ['invalid ticker characters', ['BBCA', 'BB-RI']],
    ['ticker too long', ['BBCA', 'ABCDEFG']],
    ['blank ticker', ['BBCA', '   ']],
    ['non-string ticker', ['BBCA', 7]],
    ['duplicates after normalization', ['BBCA', ' bbca ']],
  ] as const)('rejects %s', (_label, subjects) => {
    expect(() => normalizeComparisonSubjects(subjects as unknown as readonly string[])).toThrow();
  });
});

describe('runComparisonExecutionLifecycle', () => {
  it('exports the lifecycle publicly and orders create, notification, runtime, and atomic publication', async () => {
    const f = fixture();
    const order: string[] = [];
    const controller = new AbortController();
    const onWorkflowEvent = vi.fn();
    const onToolEvent = vi.fn();
    f.params.lifecycle.subjects = [' bbca ', 'BbRi'];
    f.params.runtime = { dependencies: f.params.runtime.dependencies, signal: controller.signal, onWorkflowEvent, onToolEvent };
    const startedAt = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(3000);
    f.createExecution.mockImplementation(async input => {
      order.push('createExecution');
      return { ...execution, sessionId: input.sessionId, turnId: input.turnId, ticker: input.ticker, command: input.command };
    });
    f.params.onExecutionKnown = f.known.mockImplementation(async (value: ResearchExecution) => {
      order.push('onExecutionKnown');
      expect(value.ticker).toBe('BBCA');
    });
    authorities.runtime.mockImplementation(async (options: ComparisonWorkflowRuntimeOptions) => {
      order.push('runtime');
      expect(options).toEqual({
        run: { id: execution.id, ticker: 'BBCA' },
        subjects: ['BBCA', 'BBRI'],
        dependencies: f.params.runtime.dependencies,
        signal: controller.signal,
        onWorkflowEvent,
        onToolEvent,
      });
      return runtimeResult;
    });
    f.completeAndPublish.mockImplementation(async input => {
      order.push('completeAndPublish');
      expect(input).toEqual({ executionId: execution.id, payload: runtimeResult.report, executionTimeSeconds: 2 });
      return publicationResult;
    });

    try {
      const result = await runComparisonExecutionLifecycle(f.params);
      expect(order).toEqual(['createExecution', 'onExecutionKnown', 'runtime', 'completeAndPublish']);
      expect(f.createExecution).toHaveBeenCalledExactlyOnceWith({
        sessionId: execution.sessionId,
        turnId: execution.turnId,
        ticker: 'BBCA',
        command: 'compare',
      });
      expect(f.known).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ticker: 'BBCA' }));
      expect(authorities.runtime).toHaveBeenCalledOnce();
      expect(f.completeAndPublish).toHaveBeenCalledOnce();
      expect(f.settleExecution).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: 'completed', execution: completedExecution, runtime: runtimeResult, artifact });
    } finally {
      startedAt.mockRestore();
    }
  });

  it.each([
    ['empty', []],
    ['one subject', ['BBCA']],
    ['four subjects', ['BBCA', 'BBRI', 'BMRI', 'ADRO']],
    ['invalid ticker', ['BBCA', 'BB-RI']],
    ['duplicate after normalization', ['BBCA', ' bbca ']],
    ['non-string ticker', ['BBCA', 3]],
  ] as const)('rejects %s before Date.now or any authority call', async (_label, subjects) => {
    const f = fixture();
    f.params.lifecycle.subjects = subjects as unknown as readonly string[];
    const now = vi.spyOn(Date, 'now');
    try {
      await expect(runComparisonExecutionLifecycle(f.params)).rejects.toThrow();
      expect(now).not.toHaveBeenCalled();
      expect(f.createExecution).not.toHaveBeenCalled();
      expect(f.known).not.toHaveBeenCalled();
      expect(authorities.runtime).not.toHaveBeenCalled();
      expect(f.completeAndPublish).not.toHaveBeenCalled();
      expect(f.settleExecution).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('propagates createExecution failure unchanged and performs no later action', async () => {
    const f = fixture();
    const cause = new Error('Execution store unavailable');
    f.createExecution.mockRejectedValue(cause);
    await expect(runComparisonExecutionLifecycle(f.params)).rejects.toBe(cause);
    expect(f.known).not.toHaveBeenCalled();
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).not.toHaveBeenCalled();
  });

  it('settles a host notification failure and skips runtime and publication', async () => {
    const f = fixture();
    const cause = new Error('Host could not record Execution identity');
    f.known.mockRejectedValue(cause);
    const result = await runComparisonExecutionLifecycle(f.params);
    expect(authorities.runtime).not.toHaveBeenCalled();
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', execution: { id: execution.id, status: 'failed' }, cause });
  });

  it('settles a runtime failure with the original provider or policy cause', async () => {
    const f = fixture();
    const cause = new Error('Financial provider failed');
    authorities.runtime.mockRejectedValue(cause);
    const result = await runComparisonExecutionLifecycle(f.params);
    expect(f.completeAndPublish).not.toHaveBeenCalled();
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', execution: { id: execution.id, status: 'failed' }, cause });
  });

  it('unwraps only WorkflowStepError and keeps its cause for settlement', async () => {
    const f = fixture();
    const cause = new Error('Evidence policy rejected a required source');
    const wrapper = new WorkflowStepError('compare', 'collect-evidence', 'Workflow step failed', { cause });
    authorities.runtime.mockRejectedValue(wrapper);
    const result = await runComparisonExecutionLifecycle(f.params);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', cause });
  });

  it('classifies an aborted signal as cancelled with canonical text', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    f.params.runtime.signal = controller.signal;
    const cause = new Error('Workflow observed abort');
    authorities.runtime.mockRejectedValue(cause);
    const result = await runComparisonExecutionLifecycle(f.params);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'cancelled', { error: 'Aborted' });
    expect(result).toMatchObject({ outcome: 'cancelled', cause });
  });

  it('uses the supplied host abort classifier', async () => {
    const f = fixture();
    const cause = new Error('Host cancelled Comparison');
    f.params.isAbortError = error => error === cause;
    authorities.runtime.mockRejectedValue(cause);
    const result = await runComparisonExecutionLifecycle(f.params);
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'cancelled', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'cancelled', cause });
  });

  it('passes the exact runtime report to atomic publication with finite nonnegative elapsed time', async () => {
    const f = fixture();
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(500);
    f.completeAndPublish.mockImplementation(async input => {
      expect(input.executionId).toBe(execution.id);
      expect(input.payload).toBe(runtimeResult.report);
      expect(Number.isFinite(input.executionTimeSeconds)).toBe(true);
      expect(input.executionTimeSeconds).toBeGreaterThanOrEqual(0);
      return publicationResult;
    });
    try {
      const result = await runComparisonExecutionLifecycle(f.params);
      expect(f.completeAndPublish).toHaveBeenCalledOnce();
      expect(result).toEqual({ outcome: 'completed', execution: completedExecution, runtime: runtimeResult, artifact });
      expect(f.settleExecution).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('settles atomic publication failure once without retry or partial success', async () => {
    const f = fixture();
    const cause = new Error('Atomic Comparison publication failed');
    f.completeAndPublish.mockRejectedValue(cause);
    const result = await runComparisonExecutionLifecycle(f.params);
    expect(f.completeAndPublish).toHaveBeenCalledOnce();
    expect(f.settleExecution).toHaveBeenCalledExactlyOnceWith(execution.id, 'failed', { error: cause.message });
    expect(result).toMatchObject({ outcome: 'failed', cause });
  });

  it('throws a typed dual-cause error when terminal settlement fails', async () => {
    const f = fixture();
    const actionCause = new Error('Comparison runtime failed');
    const settlementCause = new Error('Execution store unavailable during settlement');
    authorities.runtime.mockRejectedValue(actionCause);
    f.settleExecution.mockRejectedValue(settlementCause);
    const result = runComparisonExecutionLifecycle(f.params);
    await expect(result).rejects.toMatchObject({
      name: 'ComparisonExecutionSettlementError',
      execution,
      intendedStatus: 'failed',
      actionCause,
      settlementCause,
      cause: settlementCause,
    } satisfies Partial<ComparisonExecutionSettlementError>);
    await expect(result).rejects.toBeInstanceOf(ComparisonExecutionSettlementError);
  });

  it.each([
    ['wrong id', { ...execution, id: 'different-execution', status: 'failed' }],
    ['wrong status', { ...execution, status: 'completed' }],
  ] as const)('throws dual-cause error when settlement returns %s', async (_label, returned) => {
    const f = fixture();
    const actionCause = new Error('Runtime failed');
    authorities.runtime.mockRejectedValue(actionCause);
    f.settleExecution.mockResolvedValue(returned as ResearchExecution);
    await expect(runComparisonExecutionLifecycle(f.params)).rejects.toMatchObject({
      name: 'ComparisonExecutionSettlementError',
      actionCause,
      settlementCause: expect.any(Error),
      cause: expect.any(Error),
    });
  });

  it('keeps the lifecycle inside Engine ports and shares U3C subject normalization', () => {
    const lifecycleSource = readFileSync(new URL('../src/compare/executionLifecycle.ts', import.meta.url), 'utf8');
    const runtimeSource = readFileSync(new URL('../src/compare/workflowRuntime.ts', import.meta.url), 'utf8');
    expect(lifecycleSource).toContain("from './subjects.js'");
    expect(runtimeSource).toContain("from './subjects.js'");
    expect(lifecycleSource).not.toMatch(/@harness\/(cli|database|postgres|context|orchestrator)/);
    expect(lifecycleSource).not.toMatch(/from ['"].*\.\.\/.*(cli|database|postgres|context)/);
  });
});
