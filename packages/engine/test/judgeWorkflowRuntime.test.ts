import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '@harness/command-core';
import { JUDGE_NODE_IDS } from '@harness/command-judge';
import type { WorkflowRestoreSeed } from '@harness/command-core';
import { createExecutionProfile, type ResearchExecution } from '@harness/session-core';
import type {
  ChallengeTurn,
  CollectedSources,
  JudgeNodeRuntimeOptions,
  JudgeTurn,
  SynthesisTurn,
  ThesisTurn,
} from '../src/judge/nodeRuntime.js';
import type { JudgeCheckpointStores, JudgeResumePlan } from '../src/judge/checkpointResume.js';
import type { WorkflowTraceStore } from '../src/runtime/workflowTraceRecorder.js';
import { runJudgeWorkflowRuntime } from '../src/judge/workflowRuntime.js';

const mocks = vi.hoisted(() => ({
  createJudgeNodeExecutors: vi.fn(),
  repairJudgeProjections: vi.fn(),
  nodeOptions: [] as unknown[],
  order: [] as string[],
  failNode: null as string | null,
  synthesisRounds: 1,
}));

vi.mock('../src/judge/nodeRuntime.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/judge/nodeRuntime.js')>();
  return { ...actual, createJudgeNodeExecutors: mocks.createJudgeNodeExecutors };
});

vi.mock('../src/judge/projectionRepair.js', () => ({
  repairJudgeProjections: mocks.repairJudgeProjections,
}));

const ticker = 'BBRI';
const runId = 'judge-runtime-test';
const judgment = {
  ticker,
  score: 70,
  stance: 'bullish' as const,
  confidence: 'moderate' as const,
  breakdown: { financialHealth: 70, growth: 70, valuation: 70, marketMomentum: null, risk: null },
  summary: 'The reviewed evidence supports a moderate upside case.',
};
const modelResult = (subagent: 'bull' | 'bear' | 'judge') => ({
  subagent,
  value: { summary: `${subagent} summary` },
  skills: [],
});
const thesis = {
  response: { reasoning: 'Bull thesis', evidenceIds: [], claims: [], messageId: 'bull-message' },
  claims: [],
  result: modelResult('bull'),
} as unknown as ThesisTurn;
const challenge = {
  response: { reasoning: 'Bear challenge', evidenceIds: [], counterpoints: [], messageId: 'bear-message' },
  counterpoints: [],
  result: modelResult('bear'),
} as unknown as ChallengeTurn;
const firstVerdict: JudgeTurn = {
  judgment,
  allClaims: [],
  needsExtra: false,
  result: modelResult('judge'),
};
const resolvedVerdict: JudgeTurn = {
  ...firstVerdict,
  judgment: { ...judgment, score: 72, summary: 'The arbitration round supports the thesis.' },
};
const synthesis: SynthesisTurn = { judgment, rounds: 1 };
const collected: CollectedSources = {
  evidence: [],
  evidenceIds: [],
  marketEvidence: [],
  newsEvidence: [],
  marketAvailable: true,
  newsAvailable: true,
  financialSnapshotId: 'snapshot-1',
};

function outputFor(nodeId: string): unknown {
  switch (nodeId) {
    case 'collect-sources': return collected;
    case 'select-supporting-evidence': return {
      evidenceZone: 'verified evidence', evidence: [], evidenceIds: [], marketAvailable: true, newsAvailable: true,
    };
    case 'round-1-bull-thesis':
    case 'conditional-bull-rebuttal': return thesis;
    case 'round-1-bear-challenge':
    case 'conditional-bear-rechallenge': return challenge;
    case 'round-2-bull-rebuttal': return thesis;
    case 'evaluate-arguments': return firstVerdict;
    case 'resolve-conflicts': return resolvedVerdict;
    case 'synthesize-verdict': return mocks.synthesisRounds === 1 ? synthesis : { ...synthesis, rounds: mocks.synthesisRounds };
    case 'fetch-market-data': return { daily: {}, foreign: {} };
    case 'fetch-news': return { news: {}, filings: {}, sentiment: {} };
    default: return {};
  }
}

function makeTraceStore(): WorkflowTraceStore & { savedSteps: Array<Record<string, unknown>> } {
  const savedSteps: Array<Record<string, unknown>> = [];
  return {
    savedSteps,
    saveStep: vi.fn(async params => { savedSteps.push(params as Record<string, unknown>); return params; }),
    recordModelCall: vi.fn(async params => params),
    listModelCallsForStep: vi.fn(async () => []),
  };
}

function makeNodeDependencies() {
  return {
    capabilityGateway: { invoke: vi.fn() },
    bull: { analyze: vi.fn(), rebuttal: vi.fn() },
    bear: { challenge: vi.fn() },
    judge: { evaluate: vi.fn() },
    validator: { assertSeenEvidence: vi.fn(), validate: vi.fn(), validateChallenge: vi.fn() },
    researchers: { market: true, news: true },
    evidence: {},
    financialSnapshots: {},
    conversation: {},
    claims: {},
    counterpoints: {},
    judgments: {},
  } as unknown as JudgeNodeRuntimeOptions['deps'];
}

const createdAt = '2026-09-27T00:00:00.000Z';

function makeCanonical() {
  const savedOutputs: Array<Record<string, unknown>> = [];
  const checkpointStores = {
    workflowNodeOutputs: {
      save: vi.fn(async output => {
        savedOutputs.push(output as Record<string, unknown>);
        return output;
      }),
      listNodeOutputsForExecution: vi.fn(async () => savedOutputs),
    },
    financialSnapshots: {
      getById: vi.fn(async () => ({ snapshotId: 'snapshot-1', fingerprint: 'snapshot-fingerprint', materializedEvidenceIds: [] })),
    },
    evidence: { getManyByIdsForRun: vi.fn(async () => []) },
    contextSnapshots: { getById: vi.fn(async () => null) },
  } as unknown as JudgeCheckpointStores;
  const execution = {
    id: runId,
    sessionId: 'session-1',
    turnId: 'turn-1',
    attempt: 1,
    ticker,
    command: 'judge',
    status: 'running',
    executionTime: null,
    error: null,
    createdAt,
    completedAt: null,
    resumeGeneration: 0,
  } satisfies ResearchExecution;
  const profile = createExecutionProfile({
    executionId: runId,
    workflowId: 'judge',
    workflowVersion: 2,
    graphFingerprint: 'judge-graph-test',
    command: 'judge',
    ticker,
    payload: {},
    createdAt,
  });
  return { execution, profile, checkpointStores, savedOutputs };
}

function makeResumePlan(restored: WorkflowRestoreSeed[]): JudgeResumePlan {
  const { profile } = makeCanonical();
  return {
    profile,
    releaseKind: 'current',
    reasoning: false,
    conditional: true,
    researchers: { market: false, news: false },
    restored,
    outputs: [],
  };
}

beforeEach(() => {
  mocks.createJudgeNodeExecutors.mockReset();
  mocks.repairJudgeProjections.mockReset();
  mocks.nodeOptions.length = 0;
  mocks.order.length = 0;
  mocks.failNode = null;
  mocks.synthesisRounds = 1;
  mocks.repairJudgeProjections.mockImplementation(async () => { mocks.order.push('repair'); });
  mocks.createJudgeNodeExecutors.mockImplementation((rawOptions: unknown) => {
    const options = rawOptions as JudgeNodeRuntimeOptions;
    mocks.nodeOptions.push(options);
    const executors: Record<string, (inputs: Readonly<Record<string, unknown>>) => Promise<unknown>> = {};
    for (const nodeId of JUDGE_NODE_IDS) {
      executors[nodeId] = async () => {
        mocks.order.push(`node:${nodeId}`);
        if (nodeId === 'identify-company') {
          options.events({ type: 'phase', phase: 'researcher', label: 'Researcher' });
          options.onToolEvent?.({ type: 'tool.started', toolId: 'financial.company-report' });
        }
        if (nodeId === 'round-1-bull-thesis') {
          await options.checkpoint?.(nodeId, thesis);
        }
        if (mocks.failNode === nodeId) throw new Error('optional source unavailable');
        return outputFor(nodeId);
      };
    }
    return executors;
  });
});

afterEach(() => vi.restoreAllMocks());

describe('Judge workflow runtime composition', () => {
  it('rejects a run identity that disagrees with its canonical Execution before runtime side effects', async () => {
    const { execution, profile, checkpointStores } = makeCanonical();
    const trace = makeTraceStore();
    const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
    const onPlan = vi.fn();

    await expect(runJudgeWorkflowRuntime({
      run: { id: 'run-B', ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      canonical: { execution, profile, checkpointStores },
      reasoning: false,
      conditional: false,
      progress: () => undefined,
      onPlan,
    })).rejects.toThrow(/Judge runtime identity does not match canonical Execution/);

    expect(onPlan).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(mocks.repairJudgeProjections).not.toHaveBeenCalled();
    expect(mocks.createJudgeNodeExecutors).not.toHaveBeenCalled();
    expect(trace.savedSteps).toEqual([]);
    expect(checkpointStores.workflowNodeOutputs.save).not.toHaveBeenCalled();
  });

  it('rejects a canonical profile that belongs to another Execution before runtime side effects', async () => {
    const { execution, profile, checkpointStores } = makeCanonical();
    const mismatchedProfile = createExecutionProfile({
      executionId: 'run-B',
      workflowId: profile.workflowId,
      workflowVersion: profile.workflowVersion,
      graphFingerprint: profile.graphFingerprint,
      command: profile.command,
      ticker: profile.ticker,
      payload: profile.payload,
      createdAt: profile.createdAt,
    });
    const trace = makeTraceStore();
    const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
    const onPlan = vi.fn();

    await expect(runJudgeWorkflowRuntime({
      run: { id: execution.id, ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      canonical: { execution, profile: mismatchedProfile, checkpointStores },
      reasoning: false,
      conditional: false,
      progress: () => undefined,
      onPlan,
    })).rejects.toThrow(/Judge runtime profile does not belong to canonical Execution/);

    expect(onPlan).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(mocks.repairJudgeProjections).not.toHaveBeenCalled();
    expect(mocks.createJudgeNodeExecutors).not.toHaveBeenCalled();
    expect(trace.savedSteps).toEqual([]);
    expect(checkpointStores.workflowNodeOutputs.save).not.toHaveBeenCalled();
  });

  it.each(['executionId', 'fingerprint'] as const)(
    'rejects a resume plan with a mismatched profile %s before runtime side effects',
    async mismatch => {
      const { execution, profile, checkpointStores } = makeCanonical();
      const resumePlan = makeResumePlan([]);
      resumePlan.profile = mismatch === 'executionId'
        ? { ...resumePlan.profile, executionId: 'run-B' }
        : { ...resumePlan.profile, fingerprint: 'f'.repeat(64) };
      const trace = makeTraceStore();
      const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
      const onPlan = vi.fn();

      await expect(runJudgeWorkflowRuntime({
        run: { id: execution.id, ticker, createdAt },
        dependencies: { node: makeNodeDependencies(), trace },
        canonical: { execution, profile, checkpointStores, projectionRepairStores: {} as never },
        resumePlan,
        reasoning: false,
        conditional: false,
        progress: () => undefined,
        onPlan,
      })).rejects.toThrow(/Judge resume plan does not match canonical Execution profile/);

      expect(onPlan).not.toHaveBeenCalled();
      expect(runner).not.toHaveBeenCalled();
      expect(mocks.repairJudgeProjections).not.toHaveBeenCalled();
      expect(mocks.createJudgeNodeExecutors).not.toHaveBeenCalled();
      expect(trace.savedSteps).toEqual([]);
      expect(checkpointStores.workflowNodeOutputs.save).not.toHaveBeenCalled();
    },
  );

  it('uses persisted resume semantics over the current caller options', async () => {
    const { execution, profile, checkpointStores } = makeCanonical();
    const trace = makeTraceStore();
    const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
    const resumePlan = {
      ...makeResumePlan([]),
      reasoning: true,
      conditional: true,
      researchers: { market: false, news: false },
    };

    await runJudgeWorkflowRuntime({
      run: { id: execution.id, ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      canonical: { execution, profile, checkpointStores, projectionRepairStores: {} as never },
      resumePlan,
      reasoning: false,
      conditional: false,
      progress: () => undefined,
    });

    const runtimeOptions = mocks.nodeOptions[0] as JudgeNodeRuntimeOptions;
    expect(runtimeOptions.reasoning).toBe(true);
    expect(runtimeOptions.conditional).toBe(true);
    expect(runtimeOptions.deps.researchers).toEqual({ market: false, news: false });
    const context = runner.mock.calls[0]?.[1] as {
      reasoningMode: string;
      conditional: boolean;
      researchers: { market: boolean; news: boolean };
    };
    expect(context.reasoningMode).toBe('reasoning');
    expect(context.conditional).toBe(true);
    expect(context.researchers).toEqual({ market: false, news: false });
  });

  it('uses one canonical runner for direct mode, projects all declared nodes, and returns typed results', async () => {
    const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
    const trace = makeTraceStore();
    const workflowEvents: unknown[] = [];
    const nodeEvents: unknown[] = [];
    const toolEvents: unknown[] = [];
    let planNodeIds: string[] = [];

    const result = await runJudgeWorkflowRuntime({
      run: { id: runId, ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      reasoning: false,
      conditional: false,
      progress: () => undefined,
      onPlan: definition => { planNodeIds = definition.nodes.map(node => node.id); },
      onWorkflowEvent: event => workflowEvents.push(event),
      onJudgeNodeEvent: event => nodeEvents.push(event),
      onToolEvent: event => toolEvents.push(event),
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(planNodeIds).toEqual([...JUDGE_NODE_IDS]);
    expect([...new Set(workflowEvents.map(event => (event as { nodeId: string }).nodeId))]).toEqual([...JUDGE_NODE_IDS]);
    expect(trace.savedSteps).toHaveLength(workflowEvents.length);
    expect(nodeEvents).toEqual([{ type: 'phase', phase: 'researcher', label: 'Researcher' }]);
    expect(toolEvents).toEqual([{ type: 'tool.started', toolId: 'financial.company-report' }]);
    expect(result.collected).toBe(collected);
    expect(result.thesis).toBe(thesis);
    expect(result.challenge).toBe(challenge);
    expect(result.rebuttal).toBe(thesis);
    expect(result.firstVerdict).toBe(firstVerdict);
    expect(result.resolvedVerdict).toBeUndefined();
    expect(result.judgeTurn).toBe(firstVerdict);
    expect(result.judgment).toBe(judgment);
    expect(result.synthesis).toBe(synthesis);
    expect(result.conditionalUsed).toBe(false);
    const runtimeOptions = mocks.nodeOptions[0] as JudgeNodeRuntimeOptions;
    expect(runtimeOptions.lifecycle).toBeUndefined();
    expect(runtimeOptions.checkpoint).toBeUndefined();
  });

  it('composes lifecycle checkpoint hooks and preserves optional-failure and skip outputs', async () => {
    mocks.failNode = 'fetch-market-data';
    const { execution, profile, checkpointStores, savedOutputs } = makeCanonical();
    const trace = makeTraceStore();

    await runJudgeWorkflowRuntime({
      run: { id: execution.id, ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      canonical: { execution, profile, checkpointStores },
      reasoning: false,
      conditional: false,
      progress: () => undefined,
    });

    expect(mocks.createJudgeNodeExecutors).toHaveBeenCalledTimes(1);
    expect(checkpointStores.workflowNodeOutputs.save).toHaveBeenCalled();
    expect(savedOutputs).toContainEqual(expect.objectContaining({
      nodeId: 'fetch-market-data',
      status: 'completed',
      payload: { outcome: 'optional-failure', errorCode: 'PROVIDER_ERROR' },
    }));
    expect(savedOutputs.filter(output => output.status === 'skipped').map(output => output.nodeId)).toEqual([
      'conditional-bear-rechallenge', 'conditional-bull-rebuttal', 'resolve-conflicts',
    ]);
    expect(savedOutputs.filter(output => output.nodeId === 'round-1-bull-thesis')).toHaveLength(2);
    const runtimeOptions = mocks.nodeOptions[0] as JudgeNodeRuntimeOptions;
    expect(runtimeOptions.lifecycle).toEqual({ sessionId: execution.sessionId, turnId: execution.turnId });
    expect(runtimeOptions.checkpoint).toEqual(expect.any(Function));
  });

  it('repairs projections before runner events, restores closure state, and passes restore seeds through', async () => {
    const runner = vi.spyOn(WorkflowRunner.prototype, 'run');
    const { execution, profile, checkpointStores } = makeCanonical();
    const runtimeChallenge = { ...challenge, counterpoints: [{ targetClaimId: 'claim-1' }] } as unknown as ChallengeTurn;
    const conditionalChallenge = { ...challenge, counterpoints: [{ targetClaimId: 'claim-2' }] } as unknown as ChallengeTurn;
    const restoredVerdict = { ...firstVerdict, needsExtra: true };
    const restored: WorkflowRestoreSeed[] = [
      { nodeId: 'identify-company', status: 'completed', value: {} },
      { nodeId: 'fetch-financials', status: 'completed', value: {} },
      { nodeId: 'fetch-market-data', status: 'skipped' },
      { nodeId: 'fetch-news', status: 'skipped' },
      { nodeId: 'collect-sources', status: 'completed', value: collected },
      { nodeId: 'select-supporting-evidence', status: 'completed', value: outputFor('select-supporting-evidence') },
      { nodeId: 'round-1-bull-thesis', status: 'completed', value: thesis },
      { nodeId: 'round-1-bear-challenge', status: 'completed', value: runtimeChallenge },
      { nodeId: 'round-2-bull-rebuttal', status: 'completed', value: thesis },
      { nodeId: 'evaluate-arguments', status: 'completed', value: restoredVerdict },
      { nodeId: 'conditional-bear-rechallenge', status: 'completed', value: conditionalChallenge },
    ];
    const resumePlan = makeResumePlan(restored);
    const firstWorkflowEvent = vi.fn(() => { mocks.order.push('workflow-event'); });
    const trace = makeTraceStore();

    await runJudgeWorkflowRuntime({
      run: { id: execution.id, ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      canonical: { execution, profile, checkpointStores, projectionRepairStores: {} as never },
      resumePlan,
      reasoning: false,
      conditional: true,
      progress: () => undefined,
      onWorkflowEvent: firstWorkflowEvent,
    });

    expect(mocks.repairJudgeProjections).toHaveBeenCalledTimes(1);
    expect(mocks.order.indexOf('repair')).toBeLessThan(mocks.order.indexOf('workflow-event'));
    expect(mocks.order).toContain('node:conditional-bull-rebuttal');
    expect(mocks.order).toContain('node:resolve-conflicts');
    const runtimeOptions = mocks.nodeOptions[0] as JudgeNodeRuntimeOptions;
    expect(runtimeOptions.decision.extraRound).toBe(true);
    expect(runtimeOptions.restored).toEqual({
      round1BearCounterpoints: runtimeChallenge.counterpoints,
      conditionalBearCounterpoints: conditionalChallenge.counterpoints,
    });
    const runOptions = runner.mock.calls[0]?.[2];
    expect(runOptions?.restored).toEqual(restored);
  });

  it('uses the resolved verdict when arbitration ran and returns the conditional-round flag', async () => {
    mocks.synthesisRounds = 2;
    const { execution, profile, checkpointStores } = makeCanonical();
    const trace = makeTraceStore();
    const result = await runJudgeWorkflowRuntime({
      run: { id: execution.id, ticker, createdAt },
      dependencies: { node: makeNodeDependencies(), trace },
      canonical: { execution, profile, checkpointStores },
      reasoning: true,
      conditional: false,
      progress: () => undefined,
    });

    expect(result.resolvedVerdict).toBe(resolvedVerdict);
    expect(result.judgeTurn).toBe(resolvedVerdict);
    expect(result.conditionalUsed).toBe(true);
  });

  it('keeps the runtime source free of host/database presentation dependencies', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/judge/workflowRuntime.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/@harness\/database|FinharnessDatabase|apps\/cli|HarnessContext|AgentEvent|ConversationController|FinharnessConfig|openDb|SQLite|process\.stdout/);
  });
});
