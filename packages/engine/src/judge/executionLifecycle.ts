import { WorkflowStepError } from '@harness/command-core';
import type { ArtifactEnvelope } from '@harness/schemas';
import type { ResearchExecution, ResearchSessionStore } from '@harness/session-core';
import {
  completeJudgeExecution,
  JudgeExecutionCompletionError,
} from './executionCompletion.js';
import {
  prepareJudgeExecution,
  JudgeExecutionPreparationError,
  type JudgeExecutionPreparationOptions,
} from './executionPreparation.js';
import { runJudgeWorkflowRuntime } from './workflowRuntime.js';
import type { JudgeWorkflowRuntimeOptions, JudgeWorkflowRuntimeResult } from './workflowRuntime.js';
import type { JudgeHistoricalArtifactStores } from './releaseReconciliation.js';
import type { JudgeReleaseStores } from './release.js';
import type { JudgeProjectionRepairStores } from './projectionRepair.js';

export type JudgeExecutionLifecycleRuntimeOptions = Pick<
  JudgeWorkflowRuntimeOptions,
  'dependencies' | 'progress' | 'signal' | 'onPlan' | 'onWorkflowEvent' | 'onJudgeNodeEvent' | 'onToolEvent'
> & {
  /** Required by a validated resume; unused for a fresh Judge invocation. */
  projectionRepairStores?: JudgeProjectionRepairStores;
};

export interface JudgeExecutionLifecycleOptions {
  readonly preparation: JudgeExecutionPreparationOptions;
  readonly runtime: JudgeExecutionLifecycleRuntimeOptions;
  readonly completion: {
    readonly sessions: Pick<ResearchSessionStore, 'settleExecution'>;
    readonly releaseStores: JudgeReleaseStores;
    readonly historicalArtifactStores: JudgeHistoricalArtifactStores;
  };
  /** Host-owned classification for cancellation errors not represented by the AbortSignal. */
  readonly isAbortError?: (error: unknown) => boolean;
  /** Reports the canonical Execution before runtime, including a fresh preparation failure. */
  readonly onExecutionKnown?: (execution: ResearchExecution) => void | Promise<void>;
}

export type JudgeExecutionLifecycleResult =
  | {
    outcome: 'completed';
    execution: ResearchExecution;
    runtime: JudgeWorkflowRuntimeResult;
    artifacts: ArtifactEnvelope[];
  }
  | {
    outcome: 'completed-publication-failed';
    execution: ResearchExecution;
    runtime: JudgeWorkflowRuntimeResult;
    cause: unknown;
  }
  | {
    outcome: 'failed' | 'cancelled';
    execution: ResearchExecution;
    cause: unknown;
  };

/** Preserves both the failed action and the canonical settlement persistence failure. */
export class JudgeExecutionSettlementError extends Error {
  readonly settlementCause: unknown;

  constructor(
    readonly execution: ResearchExecution,
    readonly intendedStatus: 'failed' | 'cancelled',
    readonly actionCause: unknown,
    settlementCause: unknown,
  ) {
    super(`Could not settle Judge Execution ${execution.id} as ${intendedStatus}`, { cause: settlementCause });
    this.name = 'JudgeExecutionSettlementError';
    this.settlementCause = settlementCause;
  }
}

function actionCause(error: unknown): unknown {
  const cause = error instanceof JudgeExecutionCompletionError ? error.cause : error;
  return cause instanceof WorkflowStepError ? cause.cause ?? cause : cause;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Coordinates the canonical Judge attempt around the existing engine authorities. */
export async function runJudgeExecutionLifecycle(
  options: JudgeExecutionLifecycleOptions,
): Promise<JudgeExecutionLifecycleResult> {
  if (options.preparation.request.resumeExecutionId && !options.runtime.projectionRepairStores) {
    throw new Error('Judge resume lifecycle requires projection repair stores before acquisition');
  }

  const startedAt = Date.now();
  let execution: ResearchExecution | undefined;
  let runtime: JudgeWorkflowRuntimeResult | undefined;
  let executionKnownNotified = false;

  const notifyExecutionKnown = async (knownExecution: ResearchExecution) => {
    executionKnownNotified = true;
    await options.onExecutionKnown?.(knownExecution);
  };

  try {
    const prepared = await prepareJudgeExecution(options.preparation);
    execution = prepared.execution;
    await notifyExecutionKnown(execution);
    runtime = await runJudgeWorkflowRuntime({
      run: { id: execution.id, ticker: execution.ticker, createdAt: execution.createdAt },
      dependencies: {
        ...options.runtime.dependencies,
        node: { ...options.runtime.dependencies.node, researchers: prepared.researchers },
      },
      reasoning: prepared.reasoning,
      conditional: prepared.conditional,
      progress: options.runtime.progress,
      signal: options.runtime.signal,
      canonical: {
        execution,
        profile: prepared.profile,
        checkpointStores: options.preparation.checkpointStores,
        ...(prepared.resumePlan && options.runtime.projectionRepairStores
          ? { projectionRepairStores: options.runtime.projectionRepairStores }
          : {}),
      },
      resumePlan: prepared.resumePlan,
      onPlan: options.runtime.onPlan,
      onWorkflowEvent: options.runtime.onWorkflowEvent,
      onJudgeNodeEvent: options.runtime.onJudgeNodeEvent,
      onToolEvent: options.runtime.onToolEvent,
    });

    const completion = await completeJudgeExecution({
      execution,
      profile: prepared.profile,
      executionTimeSeconds: (Date.now() - startedAt) / 1000,
      sessions: options.completion.sessions,
      releaseStores: options.completion.releaseStores,
      historicalArtifactStores: options.completion.historicalArtifactStores,
    });
    return {
      outcome: 'completed',
      execution: completion.execution,
      runtime,
      artifacts: completion.artifacts,
    };
  } catch (error) {
    if (error instanceof JudgeExecutionPreparationError) {
      // Resume preparation errors must stay before acquisition and settlement.
      if (options.preparation.request.resumeExecutionId) throw error;
      execution = error.execution;
      let cause = error.cause;
      if (!executionKnownNotified) {
        try {
          await notifyExecutionKnown(execution);
        } catch (notificationCause) {
          cause = new AggregateError([cause, notificationCause], 'Judge preparation and Execution notification failed');
        }
      }
      return settleFailure(options, execution, cause);
    }

    if (error instanceof JudgeExecutionCompletionError && error.phase === 'after-settlement') {
      if (!error.execution || !runtime) throw error;
      return {
        outcome: 'completed-publication-failed',
        execution: error.execution,
        runtime,
        cause: error.cause,
      };
    }

    if (!execution) throw error;
    return settleFailure(options, execution, actionCause(error));
  }
}

async function settleFailure(
  options: JudgeExecutionLifecycleOptions,
  execution: ResearchExecution,
  cause: unknown,
): Promise<Extract<JudgeExecutionLifecycleResult, { outcome: 'failed' | 'cancelled' }>> {
  const status = options.runtime.signal?.aborted || options.isAbortError?.(cause) ? 'cancelled' : 'failed';
  try {
    const settled = await options.completion.sessions.settleExecution(
      execution.id,
      status,
      { error: options.runtime.signal?.aborted ? 'Aborted' : errorMessage(cause) },
    );
    if (settled.id !== execution.id || settled.status !== status) {
      throw new Error(`Settlement did not return ${status} Judge Execution ${execution.id}`);
    }
    return { outcome: status, execution: settled, cause };
  } catch (settlementCause) {
    throw new JudgeExecutionSettlementError(execution, status, cause, settlementCause);
  }
}
