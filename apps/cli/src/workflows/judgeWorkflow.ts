import type { ExecutionRun } from '@harness/execution';
import type { ArtifactEnvelope, DurableArtifactRef, Evidence, Judgment } from '@harness/schemas';
import {
  createJudgeCommandContext, createJudgeWorkflow,
  type JudgeRoundDecision,
} from '@harness/command-judge';
import { WorkflowRunner, WorkflowStepError, type WorkflowEvent } from '@harness/command-core';
import { mapToUserFriendly, UserFriendlyError } from '@harness/shared';
import type { SkillReference } from '@harness/subagent-core';
import type { AgentEvent, UiWorkflowStepStatus } from '../repl/events';
import type { HarnessContext } from '../context';
import { WorkflowTraceRecorder } from '../runtime/workflowTraceRecorder';
import {
  assertNotAborted, createJudgeNodeExecutors,
  type BearChallengeResponse, type BullAnalysisResponse, type ChallengeTurn, type CollectedSources,
  type JudgeProgress, type JudgeTurn, type SynthesisTurn, type ThesisTurn,
} from './judgeNodes';

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
  opts: { conditional?: boolean; reasoning?: boolean; signal?: AbortSignal; lifecycle?: { sessionId: string; turnId: string } } = {},
): Promise<JudgeArtifacts> {
  const startedAt = Date.now();
  const run: ExecutionRun = opts.lifecycle
    ? await ctx.db.sessions.createExecution({ ...opts.lifecycle, ticker, command: 'judge' })
    : await ctx.db.execution.createRun({ ticker, command: 'judge' });
  const lifecycleIds = opts.lifecycle
    ? { ...opts.lifecycle, executionId: run.id }
    : {};
  let executionSettled = false;

  try {
    events({ type: 'session.start', runId: run.id, ...lifecycleIds, ticker });
    const definition = createJudgeWorkflow();
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
    const runner = new WorkflowRunner({
      onEvent: async (event) => {
        events(projectWorkflowStep(event, nodes));
        await recorder.handle(event);
      },
    });

    const decision: JudgeRoundDecision = {};
    const reasoning = Boolean(opts.reasoning);
    const conditional = Boolean(opts.conditional);
    const executors = createJudgeNodeExecutors({
      ctx, ticker, runId: run.id, events, progress, decision, reasoning, conditional,
      trace: { recordSubagentResult: (nodeId, result) => recorder.recordSubagentResult(nodeId, result) },
    });
    const context = createJudgeCommandContext({
      reasoningMode: reasoning ? 'reasoning' : 'usual',
      conditional,
      researchers: ctx.researchers,
      executors,
      decision,
    });

    const values = await runner.run(definition, context, { signal: opts.signal });
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
    const completed: ExecutionRun = opts.lifecycle
      ? await ctx.db.sessions.settleExecution(run.id, 'completed', { executionTimeSeconds })
      : await ctx.db.execution.completeRun(run.id, executionTimeSeconds);
    executionSettled = true;
    let artifactRefs: DurableArtifactRef[] = [];
    if (opts.lifecycle) {
      const storedClaims = await ctx.db.claims.getByRun(run.id);
      const envelopes: ArtifactEnvelope[] = [
        {
          artifactId: `artifact_bull_case_${run.id}`,
          kind: 'BULL_CASE',
          schemaVersion: 1,
          sessionId: opts.lifecycle.sessionId,
          turnId: opts.lifecycle.turnId,
          executionId: run.id,
          ticker,
          payload: {
            thesis: { ...thesis.response, claims: thesis.claims },
            rebuttal: { ...rebuttal.response, claims: rebuttal.claims },
          },
          createdAt: new Date().toISOString(),
        },
        {
          artifactId: `artifact_bear_case_${run.id}`,
          kind: 'BEAR_CASE',
          schemaVersion: 1,
          sessionId: opts.lifecycle.sessionId,
          turnId: opts.lifecycle.turnId,
          executionId: run.id,
          ticker,
          payload: challenge.response,
          createdAt: new Date().toISOString(),
        },
        {
          artifactId: `artifact_verdict_${run.id}`,
          kind: 'VERDICT',
          schemaVersion: 1,
          sessionId: opts.lifecycle.sessionId,
          turnId: opts.lifecycle.turnId,
          executionId: run.id,
          ticker,
          payload: { judgment, evidenceIds: collected.evidenceIds, claimIds: storedClaims.map(claim => claim.claimId), rounds: synthesis.rounds },
          createdAt: new Date().toISOString(),
        },
      ];
      const saved = await ctx.db.artifacts.saveMany(envelopes);
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
      run: completed,
      evidence: [value<Evidence>(values, 'identify-company'), value<Evidence>(values, 'fetch-financials')],
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

/**
 * Resume failed run — P1.3. Evidence sudah di-cache 24h, jadi /judge ulang
 * untuk ticker yang sama akan hit cache dan tidak buang kuota Sectors API.
 * Fungsi ini adalah alias untuk re-run normal dengan ticker yang sama.
 */
export async function resumeJudgeRun(
  ctx: HarnessContext,
  runId: string,
  progress: JudgeProgress = () => undefined,
  events: (e: AgentEvent) => void = () => undefined,
): Promise<JudgeArtifacts> {
  const oldRun = await ctx.db.execution.getRun(runId);
  if (!oldRun) throw new UserFriendlyError('NOT_FOUND', `Run ${runId} tidak ditemukan`, 'Cek /history untuk runId yang valid');
  const ticker = oldRun.ticker;
  // Re-run normal workflow — Sectors cache (24h) akan serve evidence tanpa hit API
  const { judgeWorkflow: runJudge } = await import('./judgeWorkflow.js');
  return runJudge(ctx, ticker, progress, events);
}
