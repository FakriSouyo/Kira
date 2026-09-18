import type { WorkflowDefinition, WorkflowNode } from '@harness/command-core';
import { BEAR_MANIFEST } from '@harness/subagent-bear';
import { BULL_MANIFEST } from '@harness/subagent-bull';
import { JUDGE_MANIFEST } from '@harness/subagent-judge';
import { RESEARCHER_MANIFEST } from '@harness/subagent-researcher';

/**
 * Audit roles that appear in the `/judge` trace. `researcher` owns evidence
 * collection, which the CLI adapter performs against Sectors API and the
 * evidence store — it never invokes an LLM. `bull`, `bear`, and `judge` are the
 * reasoning subagents whose prompts decide the debate.
 */
export const JUDGE_SUBAGENTS = [
  RESEARCHER_MANIFEST.id, BULL_MANIFEST.id, BEAR_MANIFEST.id, JUDGE_MANIFEST.id,
] as const;

/** Infrastructure owners. They hold no persona and never call a model. */
export const JUDGE_SERVICES = ['sectors-api', 'bull-input', 'claim-validator', 'deterministic-rubric'] as const;

/**
 * Stable visible node IDs, reconciled with proven production behavior (PR C).
 *
 * The graph is the executable truth for `/judge`: `WorkflowRunner` schedules
 * these nodes, every node is bound to a real adapter, and the order below is the
 * order the manual pipeline always executed. Nodes that only described an
 * intended architecture (separate fundamentals/valuation/risk subagents, a
 * standalone bear-input selection, a duplicate conflict resolver) were removed
 * because production behavior lived elsewhere; the discrepancy is recorded in
 * `ARCHITECTURE.md` §8 (Deviation #33).
 */
export const JUDGE_NODE_IDS = [
  'identify-company', 'fetch-financials', 'fetch-market-data', 'fetch-news', 'collect-sources',
  'select-supporting-evidence', 'round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal',
  'evaluate-arguments', 'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts',
  'check-evidence', 'synthesize-verdict',
] as const;
export type JudgeNodeId = typeof JUDGE_NODE_IDS[number];
export type JudgeExecutor = NonNullable<WorkflowNode<unknown>['executor']>;

/**
 * Shared, in-run decision written by the round-1 verdict node and read by the
 * conditional profile gate. `enabled` predicates only receive the command
 * context, so an inconclusive verdict has to travel through it.
 */
export interface JudgeRoundDecision {
  extraRound?: boolean;
}

export interface JudgeCommandContext {
  /** Usual keeps a single rebuttal round; Reasoning always runs the conditional arbitration round. */
  reasoningMode: 'usual' | 'reasoning';
  /** `--conditional` opens the arbitration round when the first verdict is inconclusive. */
  conditional: boolean;
  /** Research profile: a disabled source is skipped, never silently graded as absent evidence. */
  researchers: { market: boolean; news: boolean };
  /** True once the round-1 verdict was inconclusive; read by the conditional nodes. */
  readonly extraRound: boolean;
  execute(nodeId: JudgeNodeId, executor: JudgeExecutor, inputs: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown>;
}

/** One node's executable adapter, supplied by the composition layer (apps/cli). */
export type JudgeNodeExec = (inputs: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<unknown>;

/** Every declared node must be bound: an unbound node cannot silently become metadata. */
export type JudgeNodeExecutors = Readonly<Record<JudgeNodeId, JudgeNodeExec>>;

function node(
  id: JudgeNodeId,
  label: string,
  executor: JudgeExecutor,
  dependsOn: JudgeNodeId[] = [],
  options: Pick<WorkflowNode<JudgeCommandContext>, 'required' | 'enabled'> = {},
): WorkflowNode<JudgeCommandContext> {
  return {
    id, label, executor, dependsOn, ...options,
    run: async (context, inputs, signal) => await context.execute(id, executor, inputs, signal),
  };
}

const subagent = (id: typeof JUDGE_SUBAGENTS[number]): JudgeExecutor => ({ kind: 'subagent', id });
const service = (id: typeof JUDGE_SERVICES[number]): JudgeExecutor => ({ kind: 'service', id });

const marketResearch = (context: JudgeCommandContext): boolean => context.researchers.market;
const newsResearch = (context: JudgeCommandContext): boolean => context.researchers.news;
/** The arbitration round reopens debate for Reasoning mode, or for `--conditional` after an inconclusive verdict. */
const arbitrationRound = (context: JudgeCommandContext): boolean =>
  context.reasoningMode === 'reasoning' || (context.conditional && context.extraRound);

/**
 * `/judge` graph — order and dependencies mirror the proven pipeline exactly.
 * Evidence collection is sequential (Sectors API calls are not parallelised),
 * enrichment fetches degrade without producing evidence, and the second debate
 * round only exists when the first verdict was inconclusive.
 */
export function createJudgeWorkflow(): WorkflowDefinition<JudgeCommandContext> {
  return { id: 'judge', nodes: [
    node('identify-company', 'Identify company', subagent('researcher')),
    node('fetch-financials', 'Fetch financials', service('sectors-api'), ['identify-company']),
    node('fetch-market-data', 'Fetch market data', service('sectors-api'), ['fetch-financials'], { required: false, enabled: marketResearch }),
    node('fetch-news', 'Fetch news and sentiment', service('sectors-api'), ['fetch-market-data'], { required: false, enabled: newsResearch }),
    // Enrichment fetches may fail; persisting whatever arrived is required and fail-closed.
    node('collect-sources', 'Collect sources', subagent('researcher'), ['identify-company', 'fetch-financials', 'fetch-market-data', 'fetch-news']),
    node('select-supporting-evidence', 'Select supporting evidence', service('bull-input'), ['collect-sources']),
    node('round-1-bull-thesis', 'Round 1 Bull thesis', subagent('bull'), ['select-supporting-evidence']),
    node('round-1-bear-challenge', 'Round 1 Bear challenge', subagent('bear'), ['round-1-bull-thesis', 'select-supporting-evidence']),
    node('round-2-bull-rebuttal', 'Round 2 Bull rebuttal', subagent('bull'), ['round-1-bear-challenge', 'select-supporting-evidence']),
    node('evaluate-arguments', 'Evaluate arguments', subagent('judge'), ['round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal', 'select-supporting-evidence']),
    node('conditional-bear-rechallenge', 'Conditional Bear re-challenge', subagent('bear'), ['evaluate-arguments', 'round-1-bull-thesis', 'round-2-bull-rebuttal', 'select-supporting-evidence'], { enabled: arbitrationRound }),
    node('conditional-bull-rebuttal', 'Conditional Bull rebuttal', subagent('bull'), ['conditional-bear-rechallenge', 'select-supporting-evidence'], { enabled: arbitrationRound }),
    node('resolve-conflicts', 'Resolve conflicts', subagent('judge'), ['round-1-bull-thesis', 'round-2-bull-rebuttal', 'conditional-bull-rebuttal', 'select-supporting-evidence'], { enabled: arbitrationRound }),
    node('check-evidence', 'Check evidence', service('claim-validator'), ['select-supporting-evidence', 'round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal', 'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts']),
    node('synthesize-verdict', 'Synthesize verdict', service('deterministic-rubric'), ['evaluate-arguments', 'resolve-conflicts', 'check-evidence']),
  ] };
}

/**
 * Binds an exhaustive adapter map to the definition contract. The context is the
 * only channel through which scheduled nodes receive inputs and expose the
 * arbitration decision, so the runtime owns ordering while the composition layer
 * (apps/cli) owns persistence.
 */
export function createJudgeCommandContext(params: {
  reasoningMode: 'usual' | 'reasoning';
  conditional: boolean;
  researchers: { market: boolean; news: boolean };
  executors: JudgeNodeExecutors;
  decision?: JudgeRoundDecision;
}): JudgeCommandContext {
  const decision = params.decision ?? {};
  return {
    reasoningMode: params.reasoningMode,
    conditional: params.conditional,
    researchers: params.researchers,
    get extraRound(): boolean { return decision.extraRound === true; },
    execute: async (nodeId, _executor, inputs, signal) => await params.executors[nodeId](inputs, signal),
  };
}
