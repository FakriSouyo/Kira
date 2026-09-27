import type { ExecutionRun } from '@harness/execution';
import type { DurableArtifactRef, Evidence, Judgment } from '@harness/schemas';
import { WorkflowStepError, type WorkflowEvent } from '@harness/command-core';
import type { ResearchExecution } from '@harness/session-core';
import { mapToUserFriendly, UserFriendlyError } from '@harness/shared';
import { FinancialDataVerificationError } from '@harness/financial-data';
import {
  JudgeExecutionPreparationError,
  prepareJudgeExecution,
  prepareJudgeReleasePlan,
  publishJudgeRelease,
  runJudgeWorkflowRuntime,
  type BearChallengeResponse,
  type BullAnalysisResponse,
  type JudgeCheckpointStores,
  type JudgeNodeEvent,
  type JudgeProjectionRepairStores,
  type JudgeProgress,
  type JudgeReleasePlan,
  type PreparedJudgeExecution,
} from '@harness/engine';
import type { SkillReference } from '@harness/subagent-core';
import type { AgentEvent, UiWorkflowStepStatus } from '../repl/events';
import type { HarnessContext } from '../context';
import { createJudgeReleaseStores, ensureJudgeArtifacts } from './judgeCheckpoint';
import { projectFinancialToolEvent } from '../tools/financialToolEvents';

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

export type { JudgeProgress, JudgeProgressPhase, BullAnalysisResponse, BearChallengeResponse } from '@harness/engine';

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

function projectJudgeNodeEvent(event: JudgeNodeEvent, emit: (event: AgentEvent) => void): void {
  switch (event.type) {
    case 'phase': emit({ type: 'phase', phase: event.phase, label: event.label }); return;
    case 'agent.start': emit({ type: 'agent.start', agent: event.agent }); return;
    case 'agent.text': emit({ type: 'agent.text', agent: event.agent, text: event.text }); return;
    case 'agent.complete': emit({ type: 'agent.complete', agent: event.agent }); return;
    case 'evidence.found': emit({ type: 'evidence.found', id: event.id, source: event.source }); return;
    case 'command.output': emit({ type: 'command.output', text: event.text }); return;
  }
}

function judgeProjectionRepairStores(ctx: HarnessContext): JudgeProjectionRepairStores {
  return {
    trace: {
      getStep: (runId, nodeId) => ctx.db.sessions.getStep(runId, nodeId),
      saveStep: params => ctx.db.sessions.saveStep(params),
      listModelCallsForStep: (runId, stepId) => ctx.db.sessions.listModelCallsForStep(runId, stepId),
      recordModelCall: params => ctx.db.sessions.recordModelCall(params),
    },
    conversation: {
      addMessage: params => ctx.db.conversation.addMessage(params),
    },
    claims: {
      save: params => ctx.db.claims.save(params),
      repairLegacyCheckpointProjection: params => ctx.db.claims.repairLegacyCheckpointProjection(params),
    },
    counterpoints: {
      save: params => ctx.db.counterpoints.save(params),
    },
    judgments: {
      save: params => ctx.db.judgments.save(params),
    },
  };
}

/**
 * `/judge` composition boundary (PR C): it creates the canonical Execution,
 * invokes `WorkflowRunner` over the declared graph, projects runtime events into
 * the shared Agent-Events stream, persists the workflow trace, settles the
 * Execution exactly once, and returns the artifacts to render.
 *
 * Financial orchestration lives in the engine Judge node runtime;
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
  const checkpointStores: JudgeCheckpointStores = {
    workflowNodeOutputs: ctx.db.workflowNodeOutputs,
    financialSnapshots: ctx.db.financialSnapshots,
    evidence: ctx.db.evidence,
    contextSnapshots: ctx.db.contextSnapshots,
  };
  let releasePlan: JudgeReleasePlan | undefined;
  let prepared: PreparedJudgeExecution | undefined;
  let preparationFailure: unknown;
  let preparationFailed = false;
  let run: ExecutionRun | ResearchExecution;
  if (opts.lifecycle) {
    try {
      prepared = await prepareJudgeExecution({
        sessions: ctx.db.sessions,
        executionProfiles: ctx.db.executionProfiles,
        checkpointStores,
        lifecycle: opts.lifecycle,
        request: {
          ticker,
          command: 'judge',
          reasoning: opts.reasoning,
          conditional: opts.conditional,
          researchers: ctx.researchers,
          ...(opts.resumeExecutionId ? { resumeExecutionId: opts.resumeExecutionId } : {}),
        },
        currentRuntime: {
          provider: ctx.config?.llm.agent.providerId ?? ctx.config?.llm.agent.provider,
          model: ctx.config?.llm.agent.model,
          capabilityPlan: ctx.judgeCapabilityPlan,
          runtimePlan: ctx.runtimePlan as never,
        },
      });
      run = prepared.execution;
    } catch (error) {
      if (!(error instanceof JudgeExecutionPreparationError) || opts.resumeExecutionId) throw error;
      run = error.execution;
      preparationFailure = error.cause;
      preparationFailed = true;
    }
  } else {
    run = await ctx.db.execution.createRun({ ticker, command: 'judge' });
  }
  const profile = prepared?.profile;
  const resumePlan = prepared?.resumePlan;
  const lifecycleIds = opts.lifecycle
    ? { ...opts.lifecycle, executionId: run.id }
    : {};
  let executionSettled = false;

  try {
    if (!opts.resumeExecutionId) events({ type: 'session.start', runId: run.id, ...lifecycleIds, ticker });
    if (preparationFailed) throw preparationFailure;
    const reasoning = prepared?.reasoning ?? Boolean(opts.reasoning);
    const conditional = prepared?.conditional ?? Boolean(opts.conditional);
    const researchers = prepared?.researchers ?? ctx.researchers;
    let projectedNodes = new Map<string, ProjectedNode>();
    const runtime = await runJudgeWorkflowRuntime({
      run: { id: run.id, ticker, createdAt: run.createdAt },
      dependencies: {
        node: {
          capabilityGateway: ctx.capabilityGateway,
          bull: ctx.bull,
          bear: ctx.bear,
          judge: ctx.judge,
          validator: ctx.validator,
          researchers,
          evidence: ctx.db.evidence,
          financialSnapshots: ctx.db.financialSnapshots,
          conversation: ctx.db.conversation,
          claims: ctx.db.claims,
          counterpoints: ctx.db.counterpoints,
          judgments: ctx.db.judgments,
        },
        trace: ctx.db.sessions,
      },
      reasoning,
      conditional,
      progress,
      signal: opts.signal,
      ...(opts.lifecycle && profile ? {
        canonical: {
          execution: run as ResearchExecution,
          profile,
          checkpointStores,
          ...(resumePlan ? { projectionRepairStores: judgeProjectionRepairStores(ctx) } : {}),
        },
      } : {}),
      resumePlan,
      onPlan: definition => {
        projectedNodes = new Map<string, ProjectedNode>(definition.nodes.map(node => [node.id, node] as const));
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
      },
      onWorkflowEvent: event => events(projectWorkflowStep(event, projectedNodes)),
      onJudgeNodeEvent: event => projectJudgeNodeEvent(event, events),
      onToolEvent: event => projectFinancialToolEvent(event, { ticker, emit: events }),
    });
    const { collected, thesis, challenge, rebuttal, judgeTurn, judgment, synthesis } = runtime;

    if (opts.lifecycle && profile && (!resumePlan || resumePlan.releaseKind === 'current')) {
      releasePlan = await prepareJudgeReleasePlan({
        stores: createJudgeReleaseStores(ctx.db),
        execution: run as ResearchExecution,
        profile,
      });
    }

    const executionTimeSeconds = (Date.now() - startedAt) / 1000;
    const completed = opts.lifecycle
      ? await ctx.db.sessions.settleExecution(run.id, 'completed', { executionTimeSeconds })
      : await ctx.db.execution.completeRun(run.id, executionTimeSeconds);
    executionSettled = true;
    let artifactRefs: DurableArtifactRef[] = [];
    if (opts.lifecycle) {
      const saved = releasePlan
        ? (await publishJudgeRelease({
          stores: createJudgeReleaseStores(ctx.db),
          execution: completed as ResearchExecution,
          profile: profile!,
          plan: releasePlan,
        })).artifacts
        : await ensureJudgeArtifacts({
          db: ctx.db,
          execution: completed as ResearchExecution,
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
      conditionalUsed: runtime.conditionalUsed,
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
