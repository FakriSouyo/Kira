import type { WorkflowEvent } from '@harness/command-core';
import {
  ComparisonExecutionSettlementError,
  ComparisonNormalizationError,
  runComparisonExecutionLifecycle,
  type ComparisonExecutionLifecycleResult,
} from '@harness/engine';
import { mapToUserFriendly, UserFriendlyError } from '@harness/shared';
import type { ResearchExecution } from '@harness/session-core';
import type { AgentEvent, UiWorkflowStepStatus } from '../repl/events';
import type { HarnessContext } from '../context';
import { projectFinancialToolEvent } from '../tools/financialToolEvents';

export type CompareWorkflowResult = Extract<ComparisonExecutionLifecycleResult, { outcome: 'completed' }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUserFriendly(error: unknown, executionId: string): UserFriendlyError {
  if (error instanceof ComparisonNormalizationError) {
    return new UserFriendlyError(
      `COMPARISON_${error.code}`,
      `Comparison Execution ${executionId} could not produce a valid report (${error.code}): ${error.message}`,
      'Check that the selected companies have compatible quarterly financial data, then retry /compare.',
    );
  }
  return mapToUserFriendly(error, `Comparison failed for Execution ${executionId}.`);
}

function stepStatus(event: WorkflowEvent): UiWorkflowStepStatus {
  switch (event.type) {
    case 'workflow.step.started': return 'running';
    case 'workflow.step.skipped': return 'skipped';
    case 'workflow.step.restored': return event.status === 'completed' ? 'completed' : 'skipped';
    case 'workflow.step.completed': return 'completed';
    case 'workflow.step.cancelled': return 'cancelled';
    default: return 'failed';
  }
}

function projectWorkflowStep(event: WorkflowEvent): AgentEvent {
  return {
    type: 'workflow.step',
    workflowId: event.workflowId,
    nodeId: event.nodeId,
    label: event.label,
    status: stepStatus(event),
    ...('durationMs' in event ? { durationMs: event.durationMs } : {}),
    ...(event.type === 'workflow.step.failed' ? { error: event.error } : {}),
  };
}

function projectSessionStart(
  execution: ResearchExecution,
  lifecycle: { sessionId: string; turnId: string },
  subjects: readonly string[],
  emit: (event: AgentEvent) => void,
): void {
  emit({
    type: 'session.start',
    runId: execution.id,
    executionId: execution.id,
    sessionId: lifecycle.sessionId,
    turnId: lifecycle.turnId,
    ticker: execution.ticker,
    subjects: [...subjects],
    command: 'compare',
  });
}

function projectSessionComplete(
  execution: ResearchExecution,
  lifecycle: { sessionId: string; turnId: string },
  status: 'completed' | 'failed' | 'stopped',
  emit: (event: AgentEvent) => void,
  error?: UserFriendlyError,
): void {
  emit({
    type: 'session.complete',
    runId: execution.id,
    executionId: execution.id,
    sessionId: lifecycle.sessionId,
    turnId: lifecycle.turnId,
    status,
    ...(error ? { error: { code: error.code, message: error.message, suggestion: error.suggestion } } : {}),
  });
}

/** Thin CLI adapter: only binds host ports and event projection around Engine Compare lifecycle. */
export async function compareWorkflow(
  ctx: HarnessContext,
  subjects: readonly string[],
  emit: (event: AgentEvent) => void = () => undefined,
  options: { signal?: AbortSignal; lifecycle: { sessionId: string; turnId: string } },
): Promise<CompareWorkflowResult> {
  let result: ComparisonExecutionLifecycleResult;
  try {
    result = await runComparisonExecutionLifecycle({
      lifecycle: { ...options.lifecycle, subjects },
      sessions: ctx.db.sessions,
      publication: ctx.db.comparisonReportPublication,
      runtime: {
        dependencies: {
          capabilityGateway: ctx.capabilityGateway,
          evidence: ctx.db.evidence,
          trace: ctx.db.sessions,
        },
        signal: options.signal,
        onWorkflowEvent: event => emit(projectWorkflowStep(event)),
        onToolEvent: event => projectFinancialToolEvent(event, { emit }),
      },
      isAbortError: error => error instanceof UserFriendlyError && error.code === 'ABORTED',
      onExecutionKnown: execution => projectSessionStart(execution, options.lifecycle, subjects, emit),
    });
  } catch (error) {
    if (error instanceof ComparisonExecutionSettlementError) {
      const friendly = new UserFriendlyError(
        'PERSISTENCE_FAILED',
        `Comparison Execution ${error.execution.id} action failed (${errorMessage(error.actionCause)}); its terminal status (${error.intendedStatus}) could not be saved: ${errorMessage(error.settlementCause)}`,
        'Check database access before retrying /compare.',
      );
      // The canonical Turn lifecycle preserves a running Turn while this
      // Execution remains unresolved. Do not claim a terminal Session event.
      throw friendly;
    }
    throw error;
  }

  const execution = result.execution;
  switch (result.outcome) {
    case 'completed':
      projectSessionComplete(execution, options.lifecycle, 'completed', emit);
      return result;
    case 'failed':
    case 'cancelled': {
      const cancelled = result.outcome === 'cancelled';
      const friendly = cancelled
        ? result.cause instanceof UserFriendlyError && result.cause.code === 'ABORTED'
          ? result.cause
          : new UserFriendlyError('ABORTED', 'Aborted', 'Comparison cancelled at a workflow boundary.')
        : toUserFriendly(result.cause, execution.id);
      projectSessionComplete(execution, options.lifecycle, cancelled ? 'stopped' : 'failed', emit, friendly);
      throw friendly;
    }
  }
}
