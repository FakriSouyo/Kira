import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { JUDGE_NODE_IDS } from '@harness/command-judge';
import { createJudgeNodeExecutors, type JudgeNodeRuntimeDependencies } from '@harness/engine';
import { financialToolIds } from '@harness/engine';
import type { ToolRuntimeEvent } from '@harness/tool-runtime';

const ticker = 'BBRI';
const runId = 'execution-judge-node-runtime';
const metadata = (source: string) => ({
  providerId: 'test-provider',
  source,
  origin: 'MOCK' as const,
  fetchedAt: '2026-09-25T00:00:00.000Z',
  dataAsOf: null,
  requestedAsOf: null,
  period: null,
  derivedFrom: [],
});

function createRuntime() {
  const evidenceRows: Array<Record<string, unknown>> = [];
  const claimRows: Array<Record<string, unknown>> = [];
  const counterpointRows: Array<Record<string, unknown>> = [];
  const conversationRows: Array<Record<string, unknown>> = [];
  const judgmentWrites: unknown[] = [];
  const snapshotWrites: unknown[] = [];
  const checkpointNodes: string[] = [];
  const tracedNodes: string[] = [];
  const rawToolEvents: ToolRuntimeEvent[] = [];

  const financialResults = new Map<string, unknown>([
    [financialToolIds.companyReport, {
      data: { ticker, financials: { roe: 22.4 }, valuation: { pe: 12.1 } },
      metadata: metadata('mock.company_report'),
    }],
    [financialToolIds.quarterlyFinancials, {
      data: { ticker, quarters: [{ period: '2026-Q2', revenue: 100, netIncome: 12 }] },
      metadata: metadata('mock.quarterly_financials'),
    }],
  ]);

  const capabilityGateway = {
    invoke: vi.fn(async (_principal: unknown, capabilityId: string, _input: unknown, options?: {
      signal?: AbortSignal;
      onEvent?: (event: ToolRuntimeEvent) => unknown | Promise<unknown>;
    }) => {
      const value = financialResults.get(capabilityId);
      if (!value) throw new Error(`Unexpected financial capability ${capabilityId}`);
      await options?.onEvent?.({ type: 'tool.started', toolId: capabilityId });
      await options?.onEvent?.({ type: 'tool.completed', toolId: capabilityId, durationMs: 1 });
      return { value, metadata: { toolId: capabilityId, durationMs: 1 } };
    }),
  };

  const evidence = {
    accept: vi.fn(async (params: { runId: string; ticker: string; source: string; data: Record<string, unknown>; acceptance: Record<string, unknown> }) => {
      const row = {
        id: randomUUID(), runId: params.runId, ticker: params.ticker, source: params.source,
        sourceType: 'mock', contentHash: `hash-${evidenceRows.length}`, retrievedAt: '2026-09-25T00:00:00.000Z',
        data: params.data, acceptance: params.acceptance,
      };
      evidenceRows.push(row);
      return row;
    }),
    getManyByIdsForRun: vi.fn(async (requestedRunId: string, ids: string[]) => evidenceRows.filter(row => row.runId === requestedRunId && ids.includes(String(row.id)))),
    getByRun: vi.fn(async (requestedRunId: string) => evidenceRows.filter(row => row.runId === requestedRunId)),
  };

  const claims = {
    save: vi.fn(async ({ runId: savedRunId, messageId, claim }: { runId: string; messageId: string; claim: Record<string, unknown> }) => {
      const row = {
        id: `stored-${String(claim.claimId)}`, runId: savedRunId, messageId,
        claimId: claim.claimId, statement: claim.statement, confidence: claim.confidence,
        reasoning: claim.reasoning, evidenceIds: claim.evidenceIds, citedFigures: claim.citedFigures,
        singleMetric: claim.singleMetric, evidenceLinks: claim.evidenceLinks,
        policyId: claim.policyId, policyFingerprint: claim.policyFingerprint,
        createdAt: '2026-09-25T00:00:00.000Z',
      };
      claimRows.push(row);
      return row;
    }),
    getByRun: vi.fn(async (requestedRunId: string) => claimRows.filter(row => row.runId === requestedRunId)),
  };

  const counterpoints = {
    save: vi.fn(async ({ runId: savedRunId, messageId, counterpoint }: { runId: string; messageId: string; counterpoint: Record<string, unknown> }) => {
      const row = {
        id: `stored-${String(counterpoint.counterpointId)}`, runId: savedRunId, messageId,
        counterpointId: counterpoint.counterpointId, sourceNodeId: counterpoint.sourceNodeId,
        targetClaimId: counterpoint.targetClaimId, argument: counterpoint.argument, strength: counterpoint.strength,
        evidenceIds: counterpoint.evidenceIds, citedFigures: counterpoint.citedFigures,
        evidenceLinks: counterpoint.evidenceLinks, policyId: counterpoint.policyId,
        policyFingerprint: counterpoint.policyFingerprint, createdAt: '2026-09-25T00:00:00.000Z',
      };
      counterpointRows.push(row);
      return row;
    }),
    getByRun: vi.fn(async (requestedRunId: string) => counterpointRows.filter(row => row.runId === requestedRunId)),
  };

  const conversation = {
    addMessage: vi.fn(async (message: Record<string, unknown>) => {
      conversationRows.push({ id: `message-${conversationRows.length}`, ...message });
    }),
    getByRun: vi.fn(async (requestedRunId: string) => conversationRows.filter(row => row.runId === requestedRunId)),
  };

  const breakdown = { financialHealth: 70, growth: 70, valuation: 70, marketMomentum: null, risk: null };
  const bullProposal = (claimId: string, evidenceId: string) => ({
    reasoning: 'The verified financial evidence supports a durable operating thesis.',
    evidenceIds: [evidenceId],
    claims: [{
      claimId,
      statement: 'The company shows a durable financial profile.',
      confidence: 'moderate',
      reasoning: 'The verified source supports this claim within the reviewed period.',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'The verified financial source supports the claim.' }],
    }],
  });
  const bull = {
    analyze: vi.fn(async () => ({ value: bullProposal('bull-claim-1', String(evidenceRows[0]?.id)) })),
    rebuttal: vi.fn(async () => ({ value: bullProposal('bull-rebuttal-1', String(evidenceRows[0]?.id)) })),
  };
  const bear = {
    challenge: vi.fn(async () => {
      const evidenceId = String(evidenceRows[0]?.id);
      return { value: {
        reasoning: 'A qualifying condition remains relevant to the bullish thesis.',
        evidenceIds: [evidenceId],
        counterpoints: [{
          targetClaimId: 'bull-claim-1',
          argument: 'The available observation does not establish persistence.',
          strength: 'moderate',
          evidenceIds: [evidenceId],
          evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The observation has limited period coverage.' }],
        }],
      } };
    }),
  };
  const judge = {
    evaluate: vi.fn(async () => ({ value: {
      ticker, score: 70, stance: 'bullish', confidence: 'moderate', breakdown,
      summary: 'The verified evidence supports moderate upside.',
    } })),
  };
  const validator = {
    assertSeenEvidence: vi.fn(),
    validate: vi.fn(async (values: unknown[]) => values),
    validateChallenge: vi.fn(async () => undefined),
  };
  const financialSnapshots = {
    save: vi.fn(async (snapshot: unknown) => { snapshotWrites.push(snapshot); return snapshot; }),
  };
  const judgments = {
    save: vi.fn(async (value: unknown) => { judgmentWrites.push(value); return value; }),
  };
  const deps = {
    capabilityGateway, bull, bear, judge, validator,
    researchers: { market: false, news: false },
    evidence, financialSnapshots, conversation, claims, counterpoints, judgments,
  } as unknown as JudgeNodeRuntimeDependencies;
  const emitted: unknown[] = [];
  const executors = createJudgeNodeExecutors({
    deps, ticker, runId,
    events: event => emitted.push(event),
    onToolEvent: event => rawToolEvents.push(event),
    progress: () => {}, decision: {}, reasoning: false, conditional: false,
    executionStartedAt: '2026-09-25T00:00:00.000Z',
    lifecycle: { sessionId: 'session-1', turnId: 'turn-1' },
    checkpoint: async nodeId => { checkpointNodes.push(nodeId); },
    trace: { recordSubagentResult: async nodeId => { tracedNodes.push(nodeId); } },
  });

  return {
    executors, emitted, rawToolEvents, capabilityGateway, evidenceRows, evidence, claims,
    counterpoints, conversation, judgmentWrites, snapshotWrites, checkpointNodes, tracedNodes,
    bull, bear, judge, validator,
  };
}

describe('Judge node runtime', () => {
  it('binds exactly every declared Judge node', () => {
    const { executors } = createRuntime();
    expect(Object.keys(executors).sort()).toEqual([...JUDGE_NODE_IDS].sort());
  });

  it('uses the supplied CapabilityGateway and forwards raw ToolRuntime events', async () => {
    const { executors, capabilityGateway, rawToolEvents } = createRuntime();
    await executors['identify-company']({});

    expect(capabilityGateway.invoke).toHaveBeenCalledTimes(1);
    expect(capabilityGateway.invoke.mock.calls[0]?.[0]).toBeDefined();
    expect(capabilityGateway.invoke.mock.calls[0]?.[1]).toBe(financialToolIds.companyReport);
    expect(rawToolEvents.map(event => event.type)).toEqual(['tool.started', 'tool.completed']);
  });

  it('coordinates the supplied stores and specialist runtimes through the existing Judge nodes', async () => {
    const runtime = createRuntime();
    const { executors } = runtime;
    const report = await executors['identify-company']({});
    const financials = await executors['fetch-financials']({});
    const collected = await executors['collect-sources']({
      'identify-company': report,
      'fetch-financials': financials,
    }) as { evidenceIds: string[]; financialSnapshotId?: string };
    const selection = await executors['select-supporting-evidence']({ 'collect-sources': collected });
    const thesis = await executors['round-1-bull-thesis']({ 'select-supporting-evidence': selection }) as { claims: Array<{ claimId: string }> };
    const challenge = await executors['round-1-bear-challenge']({
      'round-1-bull-thesis': thesis,
      'select-supporting-evidence': selection,
    });
    const rebuttal = await executors['round-2-bull-rebuttal']({
      'round-1-bear-challenge': challenge,
      'select-supporting-evidence': selection,
    });
    const evaluation = await executors['evaluate-arguments']({
      'round-1-bull-thesis': thesis,
      'round-2-bull-rebuttal': rebuttal,
      'select-supporting-evidence': selection,
    });
    await executors['check-evidence']({
      'select-supporting-evidence': selection,
      'round-1-bull-thesis': thesis,
      'round-1-bear-challenge': challenge,
      'round-2-bull-rebuttal': rebuttal,
    });

    expect(collected.evidenceIds).toHaveLength(2);
    expect(runtime.evidence.accept).toHaveBeenCalledTimes(2);
    expect(runtime.snapshotWrites).toHaveLength(1);
    expect(runtime.conversation.addMessage).toHaveBeenCalled();
    expect(runtime.bull.analyze).toHaveBeenCalledTimes(1);
    expect(runtime.bull.rebuttal).toHaveBeenCalledTimes(1);
    expect(runtime.bear.challenge).toHaveBeenCalledTimes(1);
    expect(runtime.judge.evaluate).toHaveBeenCalledTimes(1);
    expect(runtime.claims.save).toHaveBeenCalledTimes(2);
    expect(runtime.counterpoints.save).toHaveBeenCalledTimes(1);
    expect(runtime.judgmentWrites).toHaveLength(1);
    expect(runtime.checkpointNodes).toEqual([
      'round-1-bull-thesis', 'round-1-bear-challenge', 'round-2-bull-rebuttal', 'evaluate-arguments',
    ]);
    expect(runtime.tracedNodes).toEqual(runtime.checkpointNodes);
    expect(runtime.emitted.some(event => (event as { type?: string }).type === 'evidence.found')).toBe(true);
    expect(evaluation).toBeDefined();
  });

  it('stops at the node boundary when the supplied AbortSignal is already aborted', async () => {
    const runtime = createRuntime();
    const controller = new AbortController();
    controller.abort();

    await expect(runtime.executors['identify-company']({}, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(runtime.capabilityGateway.invoke).not.toHaveBeenCalled();
  });

  it('rejects a model score that conflicts with the deterministic rubric', async () => {
    const { executors } = createRuntime();
    await expect(executors['synthesize-verdict']({
      'evaluate-arguments': { judgment: {
        ticker, score: 79, stance: 'bullish', confidence: 'moderate',
        breakdown: { financialHealth: 80, growth: 80, valuation: 80, marketMomentum: null, risk: null },
      }, needsExtra: false },
    })).rejects.toThrow(/score .* contradicts the rubric/i);
  });

  it('rejects a model stance that conflicts with the deterministic score', async () => {
    const { executors } = createRuntime();
    await expect(executors['synthesize-verdict']({
      'evaluate-arguments': { judgment: {
        ticker, score: 80, stance: 'neutral', confidence: 'moderate',
        breakdown: { financialHealth: 80, growth: 80, valuation: 80, marketMomentum: null, risk: null },
      }, needsExtra: false },
    })).rejects.toThrow(/stance .* contradicts the deterministic score/i);
  });

  it('has no CLI or host presentation dependency', () => {
    const source = readFileSync(new URL('../src/judge/nodeRuntime.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/(?:from|import)\s+['"][^'"]*(?:apps\/cli|\.\.\/apps)/i);
    expect(source).not.toMatch(/\b(?:HarnessContext|AgentEvent|ConversationController|FinharnessDatabase|openDb|renderer|Ink)\b|process\.stdout/);
  });
});
