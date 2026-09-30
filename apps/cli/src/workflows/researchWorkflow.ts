import type { WorkflowEvent } from '@harness/command-core';
import { FinancialDataVerificationError } from '@harness/financial-data';
import {
  ResearchExecutionSettlementError,
  runResearchExecutionLifecycle,
  type ResearchExecutionLifecycleResult,
} from '@harness/engine';
import { mapToUserFriendly, UserFriendlyError } from '@harness/shared';
import type { ResearchExecution } from '@harness/session-core';
import type { AgentEvent, UiWorkflowStepStatus } from '../repl/events';
import type { HarnessContext } from '../context';
import { projectFinancialToolEvent } from '../tools/financialToolEvents';

export type ResearchWorkflowResult = Extract<ResearchExecutionLifecycleResult, { outcome: 'completed' }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUserFriendly(error: unknown, executionId: string): UserFriendlyError {
  if (error instanceof FinancialDataVerificationError) {
    return new UserFriendlyError(
      'FINANCIAL_DATA_VERIFICATION_FAILED',
      error.message,
      `Required financial input verification failed for Research Execution ${executionId}.`,
    );
  }
  return mapToUserFriendly(error, `Research validation failed for Execution ${executionId}.`);
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
  emit: (event: AgentEvent) => void,
): void {
  emit({
    type: 'session.start',
    runId: execution.id,
    executionId: execution.id,
    sessionId: lifecycle.sessionId,
    turnId: lifecycle.turnId,
    ticker: execution.ticker,
    command: 'research',
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

/** Thin CLI adapter: only binds host stores/events around the Engine Research lifecycle. */
export async function researchWorkflow(
  ctx: HarnessContext,
  ticker: string,
  question: string,
  emit: (event: AgentEvent) => void = () => undefined,
  options: { signal?: AbortSignal; lifecycle: { sessionId: string; turnId: string } },
): Promise<ResearchWorkflowResult> {
  let result: ResearchExecutionLifecycleResult;
  try {
    result = await runResearchExecutionLifecycle({
      lifecycle: { ...options.lifecycle, ticker, question },
      sessions: ctx.db.sessions,
      publication: ctx.db.researchReportPublication,
      runtime: {
        dependencies: {
          capabilityGateway: ctx.capabilityGateway,
          evidence: ctx.db.evidence,
          researcher: ctx.researcher,
          trace: ctx.db.sessions,
        },
        signal: options.signal,
        onWorkflowEvent: event => emit(projectWorkflowStep(event)),
        onToolEvent: event => projectFinancialToolEvent(event, { ticker, emit }),
      },
      isAbortError: error => error instanceof UserFriendlyError && error.code === 'ABORTED',
      onExecutionKnown: execution => projectSessionStart(execution, options.lifecycle, emit),
    });
  } catch (error) {
    if (error instanceof ResearchExecutionSettlementError) {
      throw new UserFriendlyError(
        'PERSISTENCE_FAILED',
        `Research Execution ${error.execution.id} action failed (${errorMessage(error.actionCause)}); its terminal status (${error.intendedStatus}) could not be saved: ${errorMessage(error.settlementCause)}`,
        'Check database access before retrying.',
      );
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
          : new UserFriendlyError('ABORTED', 'Aborted', 'Research cancelled at a workflow boundary.')
        : toUserFriendly(result.cause, execution.id);
      projectSessionComplete(execution, options.lifecycle, cancelled ? 'stopped' : 'failed', emit, friendly);
      throw friendly;
    }
  }
}
