import {
  workflowGraphFingerprint,
  type WorkflowDefinition,
} from '@harness/command-core';
import { validateCapabilityPlan, type CapabilityPlan } from '@harness/capability';
import {
  createExecutionProfile,
  type ExecutionProfile,
  type JsonValue,
} from '@harness/session-core';
import { createJudgeWorkflow, type JudgeCommandContext } from './definition.js';
import { JUDGE_RELEASE_CONTRACT, JUDGE_RELEASE_CONTRACT_FINGERPRINT } from './release.js';

export const JUDGE_WORKFLOW_VERSION = 2 as const;

export type JudgeExecutionProfilePayload = {
  reasoningMode: 'usual' | 'reasoning';
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
  provider: string;
  model: string;
  capabilityPlan: JsonValue;
  capabilityPlanFingerprint: string;
  runtimePlanFingerprint?: string;
  runtimePlan?: JsonValue;
  /** Absent only on readable pre-T5 Judge profiles. */
  releaseContract?: JsonValue;
  /** Absent only on readable pre-T5 Judge profiles. */
  releaseContractFingerprint?: string;
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
  capabilityPlan: CapabilityPlan;
  runtimePlan?: JsonValue;
  createdAt: string;
}): JudgeExecutionProfile {
  const capabilityPlan = validateCapabilityPlan(params.capabilityPlan);
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
      capabilityPlan: capabilityPlan as unknown as JsonValue,
      capabilityPlanFingerprint: capabilityPlan.fingerprint,
      releaseContract: JUDGE_RELEASE_CONTRACT as unknown as JsonValue,
      releaseContractFingerprint: JUDGE_RELEASE_CONTRACT_FINGERPRINT,
      ...(params.runtimePlan ? {
        runtimePlan: params.runtimePlan,
        ...(typeof params.runtimePlan === 'object' && params.runtimePlan !== null && !Array.isArray(params.runtimePlan) && typeof params.runtimePlan.runtimeFingerprint === 'string'
          ? { runtimePlanFingerprint: params.runtimePlan.runtimeFingerprint }
          : {}),
      } : {}),
    },
    createdAt: params.createdAt,
  });
}
