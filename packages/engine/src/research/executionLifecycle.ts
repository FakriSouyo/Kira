import { WorkflowStepError } from '@harness/command-core';
import type {
  ResearchExecution,
  ResearchReportArtifact,
  ResearchReportPublicationStore,
  ResearchSessionStore,
} from '@harness/session-core';
import { runResearchWorkflowRuntime } from './workflowRuntime.js';
import type { ResearchWorkflowRuntimeOptions, ResearchWorkflowRuntimeResult } from './workflowRuntime.js';

export interface ResearchExecutionLifecycleOptions {
  lifecycle: {
    sessionId: string;
    turnId: string;
    ticker: string;
    question: string;
  };
  sessions: Pick<ResearchSessionStore, 'createExecution' | 'settleExecution'>;
  publication: Pick<ResearchReportPublicationStore, 'completeAndPublish'>;
  runtime: Pick<ResearchWorkflowRuntimeOptions, 'dependencies' | 'signal' | 'onWorkflowEvent' | 'onToolEvent'>;
  isAbortError?: (error: unknown) => boolean;
  onExecutionKnown?: (execution: ResearchExecution) => void | Promise<void>;
}

export type ResearchExecutionLifecycleResult =
  | {
    outcome: 'completed';
    execution: ResearchExecution;
    runtime: ResearchWorkflowRuntimeResult;
    artifact: ResearchReportArtifact;
  }
  | {
    outcome: 'failed' | 'cancelled';
    execution: ResearchExecution;
    cause: unknown;
  };

/** Preserves both the failed action and the canonical settlement persistence failure. */
export class ResearchExecutionSettlementError extends Error {
  readonly settlementCause: unknown;

  constructor(
    readonly execution: ResearchExecution,
    readonly intendedStatus: 'failed' | 'cancelled',
    readonly actionCause: unknown,
    settlementCause: unknown,
  ) {
    super(`Could not settle Research Execution ${execution.id} as ${intendedStatus}`, { cause: settlementCause });
    this.name = 'ResearchExecutionSettlementError';
    this.settlementCause = settlementCause;
  }
}

function actionCause(error: unknown): unknown {
  return error instanceof WorkflowStepError ? error.cause ?? error : error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function settleFailure(
  options: ResearchExecutionLifecycleOptions,
  execution: ResearchExecution,
  cause: unknown,
): Promise<Extract<ResearchExecutionLifecycleResult, { outcome: 'failed' | 'cancelled' }>> {
  const status = options.runtime.signal?.aborted || options.isAbortError?.(cause) ? 'cancelled' : 'failed';
  try {
    const settled = await options.sessions.settleExecution(execution.id, status, {
      error: options.runtime.signal?.aborted ? 'Aborted' : errorMessage(cause),
    });
    if (settled.id !== execution.id || settled.status !== status) {
      throw new Error(`Settlement did not return ${status} Research Execution ${execution.id}`);
    }
    return { outcome: status, execution: settled, cause };
  } catch (settlementCause) {
    throw new ResearchExecutionSettlementError(execution, status, cause, settlementCause);
  }
}

/** Coordinates one fresh Research Execution around the existing runtime and atomic publication ports. */
export async function runResearchExecutionLifecycle(
  options: ResearchExecutionLifecycleOptions,
): Promise<ResearchExecutionLifecycleResult> {
  const { lifecycle } = options;
  if (!lifecycle.ticker.trim()) throw new Error('Research lifecycle requires a non-empty ticker');
  if (!lifecycle.question.trim()) throw new Error('Research lifecycle requires a non-empty question');

  const startedAt = Date.now();
  const execution = await options.sessions.createExecution({
    sessionId: lifecycle.sessionId,
    turnId: lifecycle.turnId,
    ticker: lifecycle.ticker,
    command: 'research',
  });

  try {
    await options.onExecutionKnown?.(execution);
    const runtime = await runResearchWorkflowRuntime({
      run: { id: execution.id, ticker: execution.ticker },
      question: lifecycle.question,
      dependencies: options.runtime.dependencies,
      signal: options.runtime.signal,
      onWorkflowEvent: options.runtime.onWorkflowEvent,
      onToolEvent: options.runtime.onToolEvent,
    });
    const publication = await options.publication.completeAndPublish({
      executionId: execution.id,
      payload: runtime.report,
      executionTimeSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
    });
    return { outcome: 'completed', execution: publication.execution, runtime, artifact: publication.artifact };
  } catch (error) {
    return settleFailure(options, execution, actionCause(error));
  }
}
