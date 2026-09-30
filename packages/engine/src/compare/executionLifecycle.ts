import { WorkflowStepError } from '@harness/command-core';
import type {
  ComparisonReportArtifact,
  ComparisonReportPublicationStore,
  ResearchExecution,
  ResearchSessionStore,
} from '@harness/session-core';
import { normalizeComparisonSubjects } from './subjects.js';
import { runComparisonWorkflowRuntime } from './workflowRuntime.js';
import type { ComparisonWorkflowRuntimeOptions, ComparisonWorkflowRuntimeResult } from './workflowRuntime.js';

export interface ComparisonExecutionLifecycleOptions {
  lifecycle: {
    sessionId: string;
    turnId: string;
    subjects: readonly string[];
  };
  sessions: Pick<ResearchSessionStore, 'createExecution' | 'settleExecution'>;
  publication: Pick<ComparisonReportPublicationStore, 'completeAndPublish'>;
  runtime: Pick<ComparisonWorkflowRuntimeOptions, 'dependencies' | 'signal' | 'onWorkflowEvent' | 'onToolEvent'>;
  isAbortError?: (error: unknown) => boolean;
  onExecutionKnown?: (execution: ResearchExecution) => void | Promise<void>;
}

export type ComparisonExecutionLifecycleResult =
  | {
    outcome: 'completed';
    execution: ResearchExecution;
    runtime: ComparisonWorkflowRuntimeResult;
    artifact: ComparisonReportArtifact;
  }
  | {
    outcome: 'failed' | 'cancelled';
    execution: ResearchExecution;
    cause: unknown;
  };

/** Retains both the failed lifecycle action and failure to persist its terminal status. */
export class ComparisonExecutionSettlementError extends Error {
  readonly settlementCause: unknown;

  constructor(
    readonly execution: ResearchExecution,
    readonly intendedStatus: 'failed' | 'cancelled',
    readonly actionCause: unknown,
    settlementCause: unknown,
  ) {
    super(`Could not settle Comparison Execution ${execution.id} as ${intendedStatus}`, { cause: settlementCause });
    this.name = 'ComparisonExecutionSettlementError';
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
  options: ComparisonExecutionLifecycleOptions,
  execution: ResearchExecution,
  cause: unknown,
): Promise<Extract<ComparisonExecutionLifecycleResult, { outcome: 'failed' | 'cancelled' }>> {
  const signalAborted = options.runtime.signal?.aborted === true;
  const status = signalAborted || options.isAbortError?.(cause) ? 'cancelled' : 'failed';
  try {
    const settled = await options.sessions.settleExecution(execution.id, status, {
      error: signalAborted ? 'Aborted' : errorMessage(cause),
    });
    if (settled.id !== execution.id || settled.status !== status) {
      throw new Error(`Settlement did not return ${status} Comparison Execution ${execution.id}`);
    }
    return { outcome: status, execution: settled, cause };
  } catch (settlementCause) {
    throw new ComparisonExecutionSettlementError(execution, status, cause, settlementCause);
  }
}

/** Coordinates one fresh Comparison Execution around Engine runtime and atomic publication ports. */
export async function runComparisonExecutionLifecycle(
  options: ComparisonExecutionLifecycleOptions,
): Promise<ComparisonExecutionLifecycleResult> {
  const subjects = normalizeComparisonSubjects(options.lifecycle.subjects);
  const startedAt = Date.now();
  const execution = await options.sessions.createExecution({
    sessionId: options.lifecycle.sessionId,
    turnId: options.lifecycle.turnId,
    ticker: subjects[0]!,
    command: 'compare',
  });

  try {
    await options.onExecutionKnown?.(execution);
    const runtime = await runComparisonWorkflowRuntime({
      run: { id: execution.id, ticker: execution.ticker },
      subjects,
      dependencies: options.runtime.dependencies,
      signal: options.runtime.signal,
      onWorkflowEvent: options.runtime.onWorkflowEvent,
      onToolEvent: options.runtime.onToolEvent,
    });
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const publication = await options.publication.completeAndPublish({
      executionId: execution.id,
      payload: runtime.report,
      executionTimeSeconds: Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0,
    });
    return { outcome: 'completed', execution: publication.execution, runtime, artifact: publication.artifact };
  } catch (error) {
    return settleFailure(options, execution, actionCause(error));
  }
}
