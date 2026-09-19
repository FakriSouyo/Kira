import {
  workflowGraphFingerprint,
  type WorkflowDefinition,
} from '@harness/command-core';
import {
  createExecutionProfile,
  type ExecutionProfile,
  type JsonValue,
} from '@harness/session-core';
import { createJudgeWorkflow, type JudgeCommandContext } from './definition.js';

export const JUDGE_WORKFLOW_VERSION = 2 as const;

export type JudgeExecutionProfilePayload = {
  reasoningMode: 'usual' | 'reasoning';
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
  provider: string;
  model: string;
} & { [key: string]: JsonValue };

export type JudgeExecutionProfile = ExecutionProfile<JudgeExecutionProfilePayload>;

export function judgeWorkflowGraphFingerprint(definition: WorkflowDefinition<JudgeCommandContext> = createJudgeWorkflow()): string {
  return workflowGraphFingerprint(definition, JUDGE_WORKFLOW_VERSION);
}

export function createJudgeExecutionProfile(params: {
  executionId: string;
  ticker: string;
  reasoningMode: 'usual' | 'reasoning';
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
  provider: string;
  model: string;
  createdAt: string;
}): JudgeExecutionProfile {
  return createExecutionProfile({
    executionId: params.executionId,
    workflowId: 'judge',
    workflowVersion: JUDGE_WORKFLOW_VERSION,
    graphFingerprint: judgeWorkflowGraphFingerprint(),
    command: 'judge',
    ticker: params.ticker,
    payload: {
      reasoningMode: params.reasoningMode,
      conditional: params.conditional,
      researchers: params.researchers,
      provider: params.provider,
      model: params.model,
    },
    createdAt: params.createdAt,
  });
}
