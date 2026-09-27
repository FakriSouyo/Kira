import type { CapabilityPlan } from '@harness/capability';
import {
  createJudgeExecutionProfile,
  createJudgeWorkflow,
  judgeWorkflowGraphFingerprint,
  type JudgeExecutionProfile,
} from '@harness/command-judge';
import { UserFriendlyError } from '@harness/shared';
import type {
  ExecutionProfileStore,
  JsonValue,
  ResearchExecution,
  ResearchSessionStore,
} from '@harness/session-core';
import { planJudgeResume } from './checkpointResume.js';
import type { JudgeCheckpointStores, JudgeResumePlan } from './checkpointResume.js';

export interface JudgeExecutionPreparationOptions {
  /** Existing lifecycle authority; implementations remain supplied by the host. */
  sessions: Pick<ResearchSessionStore, 'createExecution' | 'getSessionArtifacts' | 'acquireInterruptedExecution'>;
  executionProfiles: ExecutionProfileStore;
  checkpointStores: JudgeCheckpointStores;
  lifecycle: { sessionId: string; turnId: string };
  request: {
    ticker: string;
    command: 'judge';
    reasoning?: boolean;
    conditional?: boolean;
    researchers: { market: boolean; news: boolean };
    /** The host has already selected this `/resume` or `/continue` target. */
    resumeExecutionId?: string;
  };
  currentRuntime: {
    provider?: string;
    model?: string;
    capabilityPlan: CapabilityPlan;
    runtimePlan?: JsonValue;
  };
}

/** Canonical Execution and persisted semantics ready for `runJudgeWorkflowRuntime`. */
export interface PreparedJudgeExecution {
  execution: ResearchExecution;
  profile: JudgeExecutionProfile;
  resumePlan?: JudgeResumePlan;
  reasoning: boolean;
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
}

/** Carries the created Execution back to the host if profile preparation fails. */
export class JudgeExecutionPreparationError extends Error {
  override readonly cause: unknown;

  constructor(readonly execution: ResearchExecution, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'JudgeExecutionPreparationError';
    this.cause = cause;
  }
}

function runtimePlanFingerprint(runtimePlan: JsonValue | undefined): string | undefined {
  if (typeof runtimePlan !== 'object' || runtimePlan === null || Array.isArray(runtimePlan)) return undefined;
  const fingerprint = runtimePlan.runtimeFingerprint;
  return typeof fingerprint === 'string' ? fingerprint : undefined;
}

function requireRuntimeIdentity(
  options: JudgeExecutionPreparationOptions,
  mode: 'fresh' | 'resume',
): { provider: string; model: string } {
  const { provider, model } = options.currentRuntime;
  if (provider === undefined || model === undefined) {
    if (mode === 'fresh') {
      throw new Error('Canonical judge execution requires runtime configuration for its execution profile');
    }
    throw new UserFriendlyError(
      'INCOMPATIBLE_CHECKPOINT',
      'The active runtime configuration is unavailable for resume validation.',
      'Start a new /judge after checking configuration.',
    );
  }
  return { provider, model };
}

function resumeNotFound(executionId: string): never {
  throw new UserFriendlyError(
    'RESUME_NOT_FOUND',
    `Execution ${executionId} is not a Judge execution in this Session.`,
    'Use /history to inspect this Session.',
  );
}

async function prepareFreshJudgeExecution(
  options: JudgeExecutionPreparationOptions,
): Promise<PreparedJudgeExecution> {
  const { lifecycle, request, currentRuntime } = options;
  const execution = await options.sessions.createExecution({
    ...lifecycle,
    ticker: request.ticker,
    command: request.command,
  });

  try {
    const { provider, model } = requireRuntimeIdentity(options, 'fresh');
    const profile = createJudgeExecutionProfile({
      executionId: execution.id,
      ticker: request.ticker,
      reasoningMode: request.reasoning ? 'reasoning' : 'usual',
      conditional: Boolean(request.conditional),
      researchers: request.researchers,
      provider,
      model,
      capabilityPlan: currentRuntime.capabilityPlan,
      runtimePlan: currentRuntime.runtimePlan,
      createdAt: execution.createdAt,
    });
    const persistedProfile = await options.executionProfiles.save(profile);
    return {
      execution,
      profile: persistedProfile as JudgeExecutionProfile,
      reasoning: profile.payload.reasoningMode === 'reasoning',
      conditional: profile.payload.conditional,
      researchers: profile.payload.researchers,
    };
  } catch (error) {
    throw new JudgeExecutionPreparationError(execution, error);
  }
}

async function prepareResumeJudgeExecution(
  options: JudgeExecutionPreparationOptions,
): Promise<PreparedJudgeExecution> {
  const { lifecycle, request, currentRuntime } = options;
  const executionId = request.resumeExecutionId!;
  const artifacts = await options.sessions.getSessionArtifacts(lifecycle.sessionId);
  const execution = artifacts.executions.find(candidate => candidate.id === executionId);
  const turn = artifacts.turns.find(candidate => candidate.id === lifecycle.turnId);

  if (artifacts.session.id !== lifecycle.sessionId
    || !execution
    || execution.sessionId !== lifecycle.sessionId
    || execution.turnId !== lifecycle.turnId
    || execution.command !== request.command
    || execution.ticker !== request.ticker) {
    resumeNotFound(executionId);
  }

  if (!turn || turn.sessionId !== lifecycle.sessionId || turn.command !== request.command) {
    throw new UserFriendlyError(
      'RESUME_TURN_UNAVAILABLE',
      `Execution ${execution.id} no longer has a Judge parent Turn in this Session.`,
      'Start a new /judge.',
    );
  }
  if (turn.status !== 'running') {
    throw new UserFriendlyError(
      'RESUME_TURN_UNAVAILABLE',
      `Execution ${execution.id} no longer has a running parent Turn.`,
      'Start a new /judge.',
    );
  }
  if (execution.status !== 'interrupted') {
    throw new UserFriendlyError(
      'RESUME_NOT_INTERRUPTED',
      `Execution ${execution.id} is ${execution.status}, not interrupted.`,
      'Only interrupted Judge executions can be resumed.',
    );
  }

  const profile = await options.executionProfiles.getByExecutionId<JudgeExecutionProfile['payload']>(execution.id);
  if (!profile) {
    throw new UserFriendlyError(
      'INCOMPATIBLE_CHECKPOINT',
      'This execution has no immutable Judge execution profile.',
      'Historical interrupted executions cannot be resumed by PR P.',
    );
  }
  if (profile.executionId !== execution.id || profile.ticker !== request.ticker
    || profile.workflowId !== request.command || profile.command !== request.command) {
    throw new UserFriendlyError(
      'INCOMPATIBLE_CHECKPOINT',
      'The immutable execution profile does not belong to this Judge Execution.',
      'Start a new /judge.',
    );
  }

  const { provider, model } = requireRuntimeIdentity(options, 'resume');
  const definition = createJudgeWorkflow();
  const resumePlan = await planJudgeResume({
    stores: options.checkpointStores,
    execution,
    profile,
    definition,
    currentGraphFingerprint: judgeWorkflowGraphFingerprint(definition),
    provider,
    model,
    runtimePlanFingerprint: runtimePlanFingerprint(currentRuntime.runtimePlan),
    capabilityPlanFingerprint: currentRuntime.capabilityPlan.fingerprint,
  });

  // Acquisition is the only operation that changes resumeGeneration. It runs
  // only after all target, profile, runtime, and checkpoint checks succeed.
  const acquired = await options.sessions.acquireInterruptedExecution(execution.id);
  if (acquired.id !== execution.id || acquired.sessionId !== lifecycle.sessionId || acquired.turnId !== lifecycle.turnId) {
    throw new Error(`Judge resume acquisition returned a different canonical Execution for ${execution.id}`);
  }
  if (acquired.resumeGeneration !== execution.resumeGeneration + 1) {
    throw new Error(`Judge resume acquisition did not advance Execution ${execution.id} by one generation`);
  }

  return {
    execution: acquired,
    profile,
    resumePlan,
    reasoning: resumePlan.reasoning,
    conditional: resumePlan.conditional,
    researchers: resumePlan.researchers,
  };
}

/** Creates or validates and acquires the canonical Judge Execution before runtime work begins. */
export async function prepareJudgeExecution(
  options: JudgeExecutionPreparationOptions,
): Promise<PreparedJudgeExecution> {
  return options.request.resumeExecutionId
    ? prepareResumeJudgeExecution(options)
    : prepareFreshJudgeExecution(options);
}
