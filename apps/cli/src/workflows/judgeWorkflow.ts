import type { ExecutionRun } from '@harness/execution';
import type { DurableArtifactRef, Evidence, Judgment } from '@harness/schemas';
import {
  createJudgeCommandContext, createJudgeWorkflow,
  createJudgeExecutionProfile,
  judgeWorkflowGraphFingerprint,
  type JudgeRoundDecision,
} from '@harness/command-judge';
import { WorkflowRunner, WorkflowStepError, type WorkflowEvent } from '@harness/command-core';
import { mapToUserFriendly, UserFriendlyError } from '@harness/shared';
import { FinancialDataVerificationError } from '@harness/financial-data';
import type { SkillReference } from '@harness/subagent-core';
import type { AgentEvent, UiWorkflowStepStatus } from '../repl/events';
import type { HarnessContext } from '../context';
import { WorkflowTraceRecorder } from '../runtime/workflowTraceRecorder';
import {
  assertNotAborted, createJudgeNodeExecutors,
  type BearChallengeResponse, type BullAnalysisResponse, type ChallengeTurn, type CollectedSources,
  type JudgeProgress, type JudgeTurn, type SynthesisTurn, type ThesisTurn,
} from './judgeNodes';
import { ensureJudgeArtifacts, JudgeCheckpointWriter, planJudgeResume, repairJudgeProjections, type JudgeResumePlan } from './judgeCheckpoint';

/**
 * Hasil lengkap /judge — dipakai renderer output conversational.
 */
export interface JudgeArtifacts {
  run: ExecutionRun;
  /** Evidence fundamental (Company Report + Quarterly Financials). */
  evidence: Evidence[];
  /** Evidence Market (Daily Transaction + Foreign Flow) — enrichment (addendum §24-A). */
  marketEvidence: Evidence[];
  /** Evidence News (News + Filings + Sentiment) — enrichment (addendum §24-A). */
  newsEvidence: Evidence[];
  /** Market tersedia → `marketMomentum` dapat dinilai (false = degrade → null). */
  marketAvailable: boolean;
  /** News tersedia → `risk` dapat dinilai (false = degrade → null). */
  newsAvailable: boolean;
  bull: BullAnalysisResponse;
  bear: BearChallengeResponse;
  rebuttal: BullAnalysisResponse;
  judgment: Judgment;
  /** Durable typed output references, empty for direct non-lifecycle callers. */
  artifactRefs: DurableArtifactRef[];
  /** Exact package-owned skills loaded for the migrated debate specialists. */
  subagentAudit: { bull: SkillReference[]; bear: SkillReference[]; judge: SkillReference[] };
  /** Conditional extra round dipakai (Phase 3 Task 2) — ditampilkan renderer. */
  conditionalUsed?: boolean;
}

export type { JudgeProgress, JudgeProgressPhase, BullAnalysisResponse, BearChallengeResponse } from './judgeNodes';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUserFriendly(error: unknown, runId: string): UserFriendlyError {
  if (error instanceof FinancialDataVerificationError) {
    return new UserFriendlyError(
      'FINANCIAL_DATA_VERIFICATION_FAILED',
      error.message,
      `Required financial input verification failed for run ${runId}.`,
    );
  }
  const mapped = mapToUserFriendly(error, `Run-scoped validation gagal pada run ${runId} — laporkan dengan run id ini.`);
  if (mapped.code === 'EVIDENCE_HALLUCINATION' || mapped.code === 'UNKNOWN_ERROR') {
    // Ganti suggestion fallback dengan runId spesifik bila generic
    const suggestion = mapped.code === 'UNKNOWN_ERROR' ? `Cek output di atas atau coba lagi. Run id: ${runId}` : mapped.suggestion;
    return new UserFriendlyError(mapped.code, mapped.message, suggestion);
  }
  return mapped;
}

/** Node metadata the step projection needs; the runtime event stays the only source of step truth. */
interface ProjectedNode {
  id: string;
  label: string;
  dependsOn?: string[];
  executor?: { kind: 'subagent' | 'service'; id: string };
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

/** Translate one runtime event for the TUI/web consumers of the Agent-Events stream. */
function projectWorkflowStep(event: WorkflowEvent, nodes: ReadonlyMap<string, ProjectedNode>): AgentEvent {
  const node = nodes.get(event.nodeId);
  return {
    type: 'workflow.step', workflowId: event.workflowId, nodeId: event.nodeId, label: event.label,
    status: stepStatus(event),
    parentIds: node?.dependsOn ?? [],
    ...(node?.executor ? { owner: node.executor.id } : {}),
    ...('durationMs' in event ? { durationMs: event.durationMs } : {}),
    ...(event.type === 'workflow.step.failed' ? { error: event.error } : {}),
  };
}

function value<T>(values: Readonly<Record<string, unknown>>, nodeId: string): T {
  return values[nodeId] as T;
}

/**
 * `/judge` composition boundary (PR C): it creates the canonical Execution,
 * invokes `WorkflowRunner` over the declared graph, projects runtime events into
 * the shared Agent-Events stream, persists the workflow trace, settles the
 * Execution exactly once, and returns the artifacts to render.
 *
 * Financial orchestration lives entirely in the node adapters (`judgeNodes.ts`);
 * there is no second, manual execution path.
 *
 * Degradasi enrichment (addendum §24-A.5): kegagalan Market/News → kategori
 * rubrik terkait `null`, run tetap `completed`. Kegagalan fundamental
 * (Company Report/Financials) atau persistence → run `failed`.
 */
export async function judgeWorkflow(
  ctx: HarnessContext,
  ticker: string,
  progress: JudgeProgress = () => {},
  events: (event: AgentEvent) => void = () => {},
  opts: { conditional?: boolean; reasoning?: boolean; signal?: AbortSignal; lifecycle?: { sessionId: string; turnId: string }; resumeExecutionId?: string } = {},
): Promise<JudgeArtifacts> {
  const startedAt = Date.now();
  const definition = createJudgeWorkflow();
  let resumePlan: JudgeResumePlan | undefined;
  let profile: Awaited<ReturnType<typeof createJudgeExecutionProfile>> | undefined;
  const run = opts.lifecycle && opts.resumeExecutionId
    ? await (async () => {
      const artifacts = await ctx.db.sessions.getSessionArtifacts(opts.lifecycle!.sessionId);
      const existing = artifacts.executions.find(candidate => candidate.id === opts.resumeExecutionId);
      if (!existing || existing.turnId !== opts.lifecycle!.turnId || existing.command !== 'judge' || existing.ticker !== ticker) {
        throw new UserFriendlyError('RESUME_NOT_FOUND', `Execution ${opts.resumeExecutionId} is not a Judge execution in this Session.`, 'Use /history to inspect this Session.');
      }
      if (existing.status !== 'interrupted') throw new UserFriendlyError('RESUME_NOT_INTERRUPTED', `Execution ${existing.id} is ${existing.status}, not interrupted.`, 'Only interrupted Judge executions can be resumed.');
      profile = await ctx.db.executionProfiles.getByExecutionId(existing.id) as typeof profile;
      if (!profile) throw new UserFriendlyError('INCOMPATIBLE_CHECKPOINT', 'This execution has no immutable Judge execution profile.', 'Historical interrupted executions cannot be resumed by PR P.');
      if (!ctx.config) throw new UserFriendlyError('INCOMPATIBLE_CHECKPOINT', 'The active runtime configuration is unavailable for resume validation.', 'Start a new /judge after checking configuration.');
      resumePlan = await planJudgeResume({
        db: ctx.db,
        execution: existing,
        profile,
        definition,
        currentGraphFingerprint: judgeWorkflowGraphFingerprint(definition),
        provider: ctx.config.llm.agent.provider,
        model: ctx.config.llm.agent.model,
      });
      return await ctx.db.sessions.acquireInterruptedExecution(existing.id);
    })()
    : opts.lifecycle
      ? await ctx.db.sessions.createExecution({ ...opts.lifecycle, ticker, command: 'judge' })
      : await ctx.db.execution.createRun({ ticker, command: 'judge' });
  const lifecycleIds = opts.lifecycle
    ? { ...opts.lifecycle, executionId: run.id }
    : {};
  let executionSettled = false;

  try {
    if (!opts.resumeExecutionId) events({ type: 'session.start', runId: run.id, ...lifecycleIds, ticker });
    const reasoning = resumePlan?.reasoning ?? Boolean(opts.reasoning);
    const conditional = resumePlan?.conditional ?? Boolean(opts.conditional);
    const researchers = resumePlan?.researchers ?? ctx.researchers;
    // Capture the immutable semantic envelope before any provider/model work.
    // Legacy direct runs intentionally remain outside the resumable contract.
    if (opts.lifecycle && !opts.resumeExecutionId) {
      if (!ctx.config) throw new Error('Canonical judge execution requires runtime configuration for its execution profile');
      profile = createJudgeExecutionProfile({
        executionId: run.id,
        ticker,
        reasoningMode: reasoning ? 'reasoning' : 'usual',
        conditional,
        researchers,
        provider: ctx.config.llm.agent.provider,
        model: ctx.config.llm.agent.model,
        createdAt: run.createdAt,
      });
      await ctx.db.executionProfiles.save(profile);
    }
    events({
      type: 'workflow.plan',
      workflowId: definition.id,
      nodes: definition.nodes.map(node => ({
        id: node.id,
        label: node.label,
        parentIds: node.dependsOn ?? [],
        ...(node.executor ? { owner: node.executor.id } : {}),
      })),
    });

    // One canonical workflow event stream: the TUI projection and the durable
    // trace recorder are subscribers, never separate sources of execution truth.
    const nodes = new Map<string, ProjectedNode>(definition.nodes.map(node => [node.id, node] as const));
    const recorder = new WorkflowTraceRecorder({ runId: run.id, definition, store: ctx.db.sessions });
    const checkpointWriter = opts.lifecycle && profile
      ? new JudgeCheckpointWriter({
        db: ctx.db,
        execution: run as unknown as import('@harness/session-core').ResearchExecution,
        profile,
        definition,
        initialOutputs: resumePlan?.outputs,
      })
      : undefined;
    if (resumePlan && opts.lifecycle) {
      await repairJudgeProjections({
        db: ctx.db,
        execution: run as unknown as import('@harness/session-core').ResearchExecution,
        outputs: resumePlan.outputs,
      });
    }
    const runner = new WorkflowRunner({
      onNodeCompleted: checkpointWriter ? (node, value, inputs) => checkpointWriter.completed(node, value, inputs) : undefined,
      onNodeSkipped: checkpointWriter ? node => checkpointWriter.skipped(node) : undefined,
      onNodeFailed: checkpointWriter ? (node, error) => checkpointWriter.optionalFailure(node, error) : undefined,
      onEvent: async (event) => {
        events(projectWorkflowStep(event, nodes));
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
      ctx, ticker, runId: run.id, events, progress, decision, reasoning, conditional, researchers,
      executionStartedAt: run.createdAt,
      lifecycle: opts.lifecycle,
      checkpoint: checkpointWriter
        ? (nodeId, value) => checkpointWriter.completedValue(nodeId, value)
        : undefined,
      restored: {
        round1BearCounterpoints: restoredRound1Bear?.response.counterpoints,
        conditionalBearCounterpoints: restoredConditionalBear?.response.counterpoints,
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

    const values = await runner.run(definition, context, { signal: opts.signal, restored: resumePlan?.restored });
    assertNotAborted(opts.signal);

    const collected = value<CollectedSources>(values, 'collect-sources');
    const thesis = value<ThesisTurn>(values, 'round-1-bull-thesis');
    const challenge = value<ChallengeTurn>(values, 'round-1-bear-challenge');
    const rebuttal = value<ThesisTurn>(values, 'round-2-bull-rebuttal');
    const firstVerdict = value<JudgeTurn>(values, 'evaluate-arguments');
    const resolved = values['resolve-conflicts'] as JudgeTurn | undefined;
    const synthesis = value<SynthesisTurn>(values, 'synthesize-verdict');
    const judgment = synthesis.judgment;
    const judgeTurn = resolved ?? firstVerdict;

    const executionTimeSeconds = (Date.now() - startedAt) / 1000;
    const completed = opts.lifecycle
      ? await ctx.db.sessions.settleExecution(run.id, 'completed', { executionTimeSeconds })
      : await ctx.db.execution.completeRun(run.id, executionTimeSeconds);
    executionSettled = true;
    let artifactRefs: DurableArtifactRef[] = [];
    if (opts.lifecycle) {
      const saved = await ensureJudgeArtifacts({
        db: ctx.db,
        execution: completed as unknown as import('@harness/session-core').ResearchExecution,
        profile: profile!,
      });
      artifactRefs = saved.map(artifact => ({ kind: artifact.kind, artifactId: artifact.artifactId }));
    }
    events({
      type: 'verdict',
      stance: judgment.stance, score: judgment.score, confidence: judgment.confidence,
      evidenceCount: collected.evidenceIds.length, rounds: synthesis.rounds,
      summary: judgment.summary, breakdown: judgment.breakdown,
    });
    events({ type: 'session.complete', runId: run.id, ...lifecycleIds, status: 'completed' });
    return {
      run: completed as ExecutionRun,
      evidence: collected.evidence.slice(0, 2),
      marketEvidence: collected.marketEvidence,
      newsEvidence: collected.newsEvidence,
      marketAvailable: collected.marketAvailable,
      newsAvailable: collected.newsAvailable,
      bull: thesis.response,
      bear: challenge.response,
      rebuttal: rebuttal.response,
      judgment,
      artifactRefs,
      subagentAudit: { bull: thesis.result.skills, bear: challenge.result.skills, judge: judgeTurn.result.skills },
      conditionalUsed: synthesis.rounds > 1,
    };
  } catch (error) {
    if (executionSettled) throw error;
    // The runtime wraps required-step failures; the user must see the original cause.
    const cause = error instanceof WorkflowStepError ? error.cause ?? error : error;
    const aborted = Boolean(opts.signal?.aborted);
    const friendly = aborted
      ? new UserFriendlyError('ABORTED', 'Aborted', 'Run cancelled at phase boundary')
      : toUserFriendly(cause, run.id);
    const cancelled = Boolean(opts.lifecycle) && (aborted || friendly.code === 'ABORTED');
    try {
      if (opts.lifecycle) {
        await ctx.db.sessions.settleExecution(run.id, cancelled ? 'cancelled' : 'failed', { error: aborted ? 'Aborted' : errorMessage(cause) });
      } else {
        await ctx.db.execution.failRun(run.id, aborted ? 'Aborted' : errorMessage(cause));
      }
      executionSettled = true;
    }
    catch (persistError) {
      throw new UserFriendlyError('PERSISTENCE_FAILED', `Run ${run.id} stopped, but its failed status could not be saved: ${errorMessage(persistError)}`, 'Check database access before retrying.');
    }
    events({ type: 'session.complete', runId: run.id, ...lifecycleIds, status: cancelled ? 'stopped' : 'failed', error: { code: friendly.code, message: friendly.message, suggestion: friendly.suggestion } });
    throw friendly;
  }
}

/** Continue an interrupted canonical Judge Execution from its validated checkpoints. */
export async function resumeJudgeRun(
  ctx: HarnessContext,
  runId: string,
  progress: JudgeProgress = () => undefined,
  events: (e: AgentEvent) => void = () => undefined,
  opts: { signal?: AbortSignal; lifecycle: { sessionId: string; turnId: string }; resumeExecutionId: string },
): Promise<JudgeArtifacts> {
  const oldRun = await ctx.db.execution.getRun(runId);
  if (!oldRun) throw new UserFriendlyError('NOT_FOUND', `Run ${runId} tidak ditemukan`, 'Cek /history untuk runId yang valid');
  const ticker = oldRun.ticker;
  return judgeWorkflow(ctx, ticker, progress, events, { ...opts, resumeExecutionId: runId });
}
