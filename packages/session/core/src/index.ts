export * from './conversation';
export * from './workingContext';
export type TurnStatus = 'running' | 'completed' | 'failed' | 'stopped';
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface ResearchSession {
  id: string;
  title: string;
  provider: string;
  model: string;
  reasoningMode: 'usual' | 'reasoning';
  createdAt: string;
  updatedAt: string;
}

export interface ResearchTurn {
  id: string;
  sessionId: string;
  /** Transitional legacy link; canonical executions point to the turn. */
  runId: string | null;
  input: string;
  command: string;
  status: TurnStatus;
  startedAt: string;
  completedAt: string | null;
}

/** One durable attempt to fulfil a turn. Workflow execution remains a separate runtime responsibility. */
export interface ResearchExecution {
  id: string;
  sessionId: string;
  turnId: string;
  attempt: number;
  ticker: string;
  command: string;
  status: ExecutionStatus;
  executionTime: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  currency: string | null;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  currency: string;
}

export type ModelTokenUsage = Pick<ModelUsage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'totalTokens'>;

/** Calculates cost only from explicit pricing; unknown usage or pricing remains unavailable. */
export function calculateModelCost(
  usage: ModelTokenUsage,
  pricing: ModelPricing | null,
): Pick<ModelUsage, 'cost' | 'currency'> {
  if (!pricing || usage.inputTokens === null || usage.outputTokens === null) {
    return { cost: null, currency: null };
  }
  const cached = usage.cachedInputTokens ?? 0;
  if (cached < 0 || cached > usage.inputTokens || usage.inputTokens < 0 || usage.outputTokens < 0) {
    return { cost: null, currency: null };
  }
  const uncached = usage.inputTokens - cached;
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const rawCost = (
    uncached * pricing.inputPerMillion
    + cached * cachedRate
    + usage.outputTokens * pricing.outputPerMillion
  ) / 1_000_000;
  return { cost: Math.round(rawCost * 1_000_000_000_000) / 1_000_000_000_000, currency: pricing.currency };
}

export type WorkflowStepStatus = 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface SkillAuditReference {
  name: string;
  contentHash: string;
}

export interface WorkflowStepRecord {
  id: string;
  runId: string;
  nodeId: string;
  parentNodeIds: string[];
  subagent: string | null;
  skills: SkillAuditReference[];
  status: WorkflowStepStatus;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ModelCallRecord extends ModelUsage {
  id: string;
  runId: string;
  stepId: string;
  subagent: string;
  provider: string;
  model: string;
  attempt: number;
  latencyMs: number;
  finishReason: string | null;
  createdAt: string;
}

export interface ResearchSessionArtifacts {
  session: ResearchSession;
  turns: ResearchTurn[];
  executions: ResearchExecution[];
  steps: WorkflowStepRecord[];
  modelCalls: ModelCallRecord[];
}

export interface ResearchSessionStore {
  createSession(params: { sessionId?: string; title: string; provider: string; model: string; reasoningMode: ResearchSession['reasoningMode'] }): Promise<ResearchSession>;
  createTurn(params: { turnId?: string; sessionId: string; runId?: string; input: string; command: string }): Promise<ResearchTurn>;
  settleTurn(turnId: string, status: Exclude<TurnStatus, 'running'>, completedAt?: string): Promise<ResearchTurn>;
  /** Starts the next attempt for a running turn; at most one attempt may run at once. */
  createExecution(params: { executionId?: string; sessionId: string; turnId: string; ticker: string; command: string }): Promise<ResearchExecution>;
  /** Atomically settles a running execution exactly once. */
  settleExecution(
    executionId: string,
    status: Exclude<ExecutionStatus, 'running'>,
    result?: { executionTimeSeconds?: number; error?: string; completedAt?: string },
  ): Promise<ResearchExecution>;
  saveStep(params: { stepId?: string; runId: string; nodeId: string; parentNodeIds: string[]; subagent?: string; skills: SkillAuditReference[]; status: WorkflowStepStatus; durationMs?: number; summary?: string; error?: string }): Promise<WorkflowStepRecord>;
  recordModelCall(params: { callId?: string; runId: string; stepId: string; subagent: string; provider: string; model: string; attempt: number; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; totalTokens: number | null; latencyMs: number; finishReason: string | null; cost: number | null; currency: string | null }): Promise<ModelCallRecord>;
  getSessionArtifacts(sessionId: string): Promise<ResearchSessionArtifacts>;
}

const TERMINAL_STATUSES = new Set<TurnStatus>(['completed', 'failed', 'stopped']);

/** Applies the only valid turn settlement transition and stamps its completion time. */
export function transitionTurn(turn: ResearchTurn, status: TurnStatus, at: string): ResearchTurn {
  if (turn.status !== 'running' || !TERMINAL_STATUSES.has(status)) {
    throw new Error(`Turn ${turn.id} cannot transition from ${turn.status} to ${status}`);
  }
  return { ...turn, status, completedAt: at };
}

function sumComplete(calls: ModelUsage[], select: (usage: ModelUsage) => number | null): number | null {
  const values = calls.map(select);
  return calls.length > 0 && values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

/** Aggregates complete billing facts; any missing call keeps the corresponding total unavailable. */
export function aggregateModelUsage(calls: ModelUsage[]): ModelUsage {
  const currencies = new Set(calls.map((usage) => usage.currency));
  const currency = calls.length > 0 && currencies.size === 1 && !currencies.has(null)
    ? calls[0]?.currency ?? null
    : null;
  const cost = currency === null ? null : sumComplete(calls, (usage) => usage.cost);
  return {
    inputTokens: sumComplete(calls, (usage) => usage.inputTokens),
    outputTokens: sumComplete(calls, (usage) => usage.outputTokens),
    cachedInputTokens: sumComplete(calls, (usage) => usage.cachedInputTokens),
    totalTokens: sumComplete(calls, (usage) => usage.totalTokens),
    cost,
    currency: cost === null ? null : currency,
  };
}
