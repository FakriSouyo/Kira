import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import { createJudgeCommandContext, createJudgeWorkflow, type JudgeRoundDecision } from '@harness/command-judge';
import { WorkflowRunner, type WorkflowEvent } from '@harness/command-core';
import type { ExecutionProfile, ResearchExecution } from '@harness/session-core';
import { assertNotAborted, createJudgeNodeExecutors } from './nodeRuntime.js';
import type {
  ChallengeTurn,
  CollectedSources,
  JudgeNodeEvent,
  JudgeNodeRuntimeDependencies,
  JudgeProgress,
  JudgeTurn,
  SynthesisTurn,
  ThesisTurn,
} from './nodeRuntime.js';
import { JudgeCheckpointWriter } from './checkpointResume.js';
import type { JudgeCheckpointStores, JudgeResumePlan } from './checkpointResume.js';
import { repairJudgeProjections } from './projectionRepair.js';
import type { JudgeProjectionRepairStores } from './projectionRepair.js';
import { WorkflowTraceRecorder } from '../runtime/workflowTraceRecorder.js';
import type { TraceableWorkflowDefinition, WorkflowTraceStore } from '../runtime/workflowTraceRecorder.js';

/** Identity required by node execution and trace recording in either host mode. */
export interface JudgeWorkflowRunIdentity {
  id: string;
  ticker: string;
  createdAt: string;
}

/** Already-composed authorities supplied by the host; persistence stays host-owned. */
export interface JudgeWorkflowRuntimeDependencies {
  node: JudgeNodeRuntimeDependencies;
  trace: WorkflowTraceStore;
}

/** Canonical lifecycle stores used for semantic checkpoints and post-acquisition repair. */
export interface JudgeWorkflowCanonicalRuntime {
  execution: ResearchExecution;
  profile: ExecutionProfile;
  checkpointStores: JudgeCheckpointStores;
  projectionRepairStores?: JudgeProjectionRepairStores;
}

export interface JudgeWorkflowRuntimeOptions {
  run: JudgeWorkflowRunIdentity;
  dependencies: JudgeWorkflowRuntimeDependencies;
  reasoning: boolean;
  conditional: boolean;
  progress: JudgeProgress;
  signal?: AbortSignal;
  canonical?: JudgeWorkflowCanonicalRuntime;
  /** Already planned and, for canonical runs, already acquired by the caller. */
  resumePlan?: JudgeResumePlan;
  onPlan?: (definition: TraceableWorkflowDefinition) => void;
  onWorkflowEvent?: (event: WorkflowEvent) => void;
  onJudgeNodeEvent?: (event: JudgeNodeEvent) => void;
  onToolEvent?: (event: ToolRuntimeEvent) => void;
}

/** Typed semantic outputs from one completed Judge graph execution. */
export interface JudgeWorkflowRuntimeResult {
  collected: CollectedSources;
  thesis: ThesisTurn;
  challenge: ChallengeTurn;
  rebuttal: ThesisTurn;
  firstVerdict: JudgeTurn;
  resolvedVerdict?: JudgeTurn;
  synthesis: SynthesisTurn;
  judgment: SynthesisTurn['judgment'];
  judgeTurn: JudgeTurn;
  conditionalUsed: boolean;
}

function value<T>(values: Readonly<Record<string, unknown>>, nodeId: string): T {
  return values[nodeId] as T;
}

function assertJudgeWorkflowRuntimeBoundary(options: JudgeWorkflowRuntimeOptions): void {
  const { run, canonical, resumePlan } = options;

  if (resumePlan && !canonical) {
    throw new Error('A Judge resume plan requires canonical execution and checkpoint stores');
  }

  if (canonical) {
    const { execution, profile } = canonical;
    if (run.id !== execution.id || run.ticker !== execution.ticker || run.createdAt !== execution.createdAt) {
      throw new Error(
        `Judge runtime identity does not match canonical Execution (run ${run.id}/${run.ticker}/${run.createdAt}; execution ${execution.id}/${execution.ticker}/${execution.createdAt})`,
      );
    }
    if (profile.executionId !== execution.id || profile.ticker !== execution.ticker) {
      throw new Error(
        `Judge runtime profile does not belong to canonical Execution (profile ${profile.executionId}/${profile.ticker}; execution ${execution.id}/${execution.ticker})`,
      );
    }
    if (profile.workflowId !== 'judge' || profile.command !== 'judge') {
      throw new Error(
        `Judge runtime profile is not a Judge profile (workflow ${profile.workflowId}; command ${profile.command})`,
      );
    }
  }

  if (resumePlan) {
    if (!canonical?.projectionRepairStores) {
      throw new Error('A Judge resume plan requires projection repair stores');
    }
    if (resumePlan.profile.executionId !== canonical.execution.id
      || resumePlan.profile.fingerprint !== canonical.profile.fingerprint) {
      throw new Error(
        `Judge resume plan does not match canonical Execution profile (resume ${resumePlan.profile.executionId}/${resumePlan.profile.fingerprint}; canonical ${canonical.profile.executionId}/${canonical.profile.fingerprint})`,
      );
    }
  }
}

/**
 * Executes the canonical Judge graph through one WorkflowRunner for both
 * direct legacy runs and canonical lifecycle runs. Lifecycle selection,
 * acquisition, release publication, settlement, and host event projection
 * remain with the caller.
 */
export async function runJudgeWorkflowRuntime(
  options: JudgeWorkflowRuntimeOptions,
): Promise<JudgeWorkflowRuntimeResult> {
  assertJudgeWorkflowRuntimeBoundary(options);

  const { run, canonical, resumePlan } = options;
  const reasoning = resumePlan?.reasoning ?? options.reasoning;
  const conditional = resumePlan?.conditional ?? options.conditional;
  const researchers = resumePlan?.researchers ?? options.dependencies.node.researchers;

  const definition = createJudgeWorkflow();
  options.onPlan?.(definition);

  const recorder = new WorkflowTraceRecorder({ runId: run.id, definition, store: options.dependencies.trace });
  const checkpointWriter = canonical
    ? new JudgeCheckpointWriter({
      stores: canonical.checkpointStores,
      execution: canonical.execution,
      profile: canonical.profile,
      definition,
      initialOutputs: resumePlan?.outputs,
    })
    : undefined;

  // The caller plans and acquires the same Execution before entering runtime.
  // Repair is therefore safe here and always precedes WorkflowRunner restore.
  if (resumePlan && canonical?.projectionRepairStores) {
    await repairJudgeProjections({
      stores: canonical.projectionRepairStores,
      execution: canonical.execution,
      outputs: resumePlan.outputs,
    });
  }

  const runner = new WorkflowRunner({
    onNodeCompleted: checkpointWriter
      ? (node, output, inputs) => checkpointWriter.completed(node, output, inputs)
      : undefined,
    onNodeSkipped: checkpointWriter ? node => checkpointWriter.skipped(node) : undefined,
    onNodeFailed: checkpointWriter ? (node, error) => checkpointWriter.optionalFailure(node, error) : undefined,
    onEvent: async event => {
      options.onWorkflowEvent?.(event);
      await recorder.handle(event);
    },
  });

  const decision: JudgeRoundDecision = {};
  const restoredValue = <T>(nodeId: string): T | undefined => {
    const seed = resumePlan?.restored.find(candidate => candidate.nodeId === nodeId);
    return seed?.status === 'completed' ? seed.value as T : undefined;
  };
  const restoredEvaluation = restoredValue<JudgeTurn>('evaluate-arguments');
  if (restoredEvaluation) decision.extraRound = restoredEvaluation.needsExtra;
  const restoredRound1Bear = restoredValue<ChallengeTurn>('round-1-bear-challenge');
  const restoredConditionalBear = restoredValue<ChallengeTurn>('conditional-bear-rechallenge');
  const executors = createJudgeNodeExecutors({
    deps: { ...options.dependencies.node, researchers },
    ticker: run.ticker,
    runId: run.id,
    events: options.onJudgeNodeEvent ?? (() => undefined),
    onToolEvent: options.onToolEvent,
    progress: options.progress,
    decision,
    reasoning,
    conditional,
    executionStartedAt: run.createdAt,
    lifecycle: canonical
      ? { sessionId: canonical.execution.sessionId, turnId: canonical.execution.turnId }
      : undefined,
    checkpoint: checkpointWriter
      ? (nodeId, output) => checkpointWriter.completedValue(nodeId, output)
      : undefined,
    restored: {
      round1BearCounterpoints: restoredRound1Bear?.counterpoints,
      conditionalBearCounterpoints: restoredConditionalBear?.counterpoints,
    },
    trace: { recordSubagentResult: (nodeId, result) => recorder.recordSubagentResult(nodeId, result) },
  });
  const context = createJudgeCommandContext({
    reasoningMode: reasoning ? 'reasoning' : 'usual',
    conditional,
    researchers,
    executors,
    decision,
  });

  const values = await runner.run(definition, context, { signal: options.signal, restored: resumePlan?.restored });
  assertNotAborted(options.signal);

  const collected = value<CollectedSources>(values, 'collect-sources');
  const thesis = value<ThesisTurn>(values, 'round-1-bull-thesis');
  const challenge = value<ChallengeTurn>(values, 'round-1-bear-challenge');
  const rebuttal = value<ThesisTurn>(values, 'round-2-bull-rebuttal');
  const firstVerdict = value<JudgeTurn>(values, 'evaluate-arguments');
  const resolvedVerdict = values['resolve-conflicts'] as JudgeTurn | undefined;
  const synthesis = value<SynthesisTurn>(values, 'synthesize-verdict');

  return {
    collected,
    thesis,
    challenge,
    rebuttal,
    firstVerdict,
    ...(resolvedVerdict ? { resolvedVerdict } : {}),
    synthesis,
    judgment: synthesis.judgment,
    judgeTurn: resolvedVerdict ?? firstVerdict,
    conditionalUsed: synthesis.rounds > 1,
  };
}
