import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityGateway } from '@harness/capability';
import type { EvidenceStore } from '@harness/evidence';
import type { FinancialDataResult, CompanyReport, Filing, NewsArticle, QuarterlyFinancials } from '@harness/financial-data';
import type { SubagentResult } from '@harness/subagent-core';
import type { ResearchReportPayload, Evidence } from '@harness/schemas';
import type { ResearchRequest, ResearcherOutput } from '@harness/subagent-researcher';
import { ResearchReportPayloadSchema } from '@harness/schemas';
import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import type { WorkflowTraceStore } from '../src/runtime/workflowTraceRecorder.js';
import { financialToolIds, runResearchWorkflowRuntime } from '../src/index.js';
import type { ResearchWorkflowRuntimeDependencies } from '../src/research/workflowRuntime.js';

const run = { id: 'execution-research-1', ticker: 'BBRI' };
const question = 'How did the company perform this quarter?';
const ids = {
  company_report: '11111111-1111-4111-8111-111111111111',
  quarterly_financials: '22222222-2222-4222-8222-222222222222',
  news: '33333333-3333-4333-8333-333333333333',
  filings: '44444444-4444-4444-8444-444444444444',
  outside: '55555555-5555-4555-8555-555555555555',
} as const;

const report: CompanyReport = {
  ticker: 'BBRI',
  name: 'Bank Rakyat Indonesia',
  asOf: '2026-09-25T00:00:00.000Z',
  financials: { roe: 20.4 },
  valuation: { pe: 12.1 },
};
const quarterly: QuarterlyFinancials = {
  ticker: 'BBRI',
  currency: 'IDR',
  quarters: [{ period: 'Q2 2026', periodType: 'single_quarter', revenue: 3_000_000, netIncome: 500_000 }],
};
const news: NewsArticle[] = [{
  id: 'news-1', ticker: 'BBRI', headline: 'Bank reports steady growth',
  publishedAt: '2026-09-25T00:00:00.000Z', snippet: 'Quarterly results were published.',
}];
const filings: Filing[] = [{
  id: 'filing-1', ticker: 'BBRI', type: 'quarterly', title: 'Quarterly filing',
  filedAt: '2026-09-25T00:00:00.000Z',
}];

function result<T>(source: string, data: T, options: { dataAsOf?: string | null; period?: string | null } = {}): FinancialDataResult<T> {
  return {
    data,
    metadata: {
      providerId: 'test-provider',
      source,
      origin: 'MOCK',
      fetchedAt: '2026-09-26T00:00:00.000Z',
      dataAsOf: options.dataAsOf ?? null,
      requestedAsOf: null,
      period: options.period ?? null,
      derivedFrom: [],
    },
  };
}

function researcherOutput(evidenceId: string = ids.quarterly_financials): ResearcherOutput {
  return {
    summary: 'Quarterly revenue reached 3,000,000 in Q2 2026.',
    findings: [{
      claim: 'Quarterly revenue reached 3,000,000.',
      evidenceIds: [evidenceId],
      confidence: 'high',
      citedFigures: [{
        evidenceId,
        path: 'quarters[0].revenue',
        value: 3_000_000,
        periodLabel: 'Q2 2026',
      }],
    }],
    sourceAssessments: [{ evidenceId, quality: 'primary', rationale: 'The cited quarterly result is primary evidence.' }],
    gaps: [],
  };
}

interface HarnessOptions {
  failProvider?: 'news' | 'filings';
  malformedQuarterly?: boolean;
  malformedNews?: boolean;
  failedAcceptKind?: keyof typeof ids;
  output?: ResearcherOutput;
}

function harness(options: HarnessOptions = {}) {
  const evidenceRows: Evidence[] = [];
  const invocations: string[] = [];
  const evidenceKinds: string[] = [];
  const dataByTool: Record<string, unknown> = {
    [financialToolIds.companyReport]: result('mock.company_report', report, { dataAsOf: report.asOf }),
    [financialToolIds.quarterlyFinancials]: result('mock.quarterly_financials', options.malformedQuarterly
      ? { ticker: 'BBRI', quarters: [{ period: 'Q2 2026', netIncome: 500_000 }] } as unknown as QuarterlyFinancials
      : quarterly, { period: 'Q2 2026' }),
    [financialToolIds.news]: result('mock.news', options.malformedNews
      ? [{ ...news[0]!, ticker: 'BBCA' }]
      : news),
    [financialToolIds.filings]: result('mock.filings', filings),
  };
  const invoke = vi.fn(async (
    _principal: { id: string },
    capabilityId: string,
    _input: unknown,
    _invocationOptions?: { signal?: AbortSignal; onEvent?: (event: ToolRuntimeEvent) => void },
  ) => {
    invocations.push(capabilityId);
    const source = capabilityId === financialToolIds.companyReport ? 'company_report'
      : capabilityId === financialToolIds.quarterlyFinancials ? 'quarterly_financials'
        : capabilityId === financialToolIds.news ? 'news' : 'filings';
    if (options.failProvider === source) {
      const code = source === 'news' ? 'NETWORK' : 'TIMEOUT';
      throw Object.assign(new Error('private provider diagnostic'), { code });
    }
    return { value: dataByTool[capabilityId] };
  });

  const accept = vi.fn(async (params: Parameters<EvidenceStore['accept']>[0]) => {
    const kind = String(params.acceptance.provenance.observationKind);
    evidenceKinds.push(kind);
    if (kind === options.failedAcceptKind) throw Object.assign(new Error('storage unavailable'), { code: 'STORE_UNAVAILABLE' });
    const evidence = {
      id: ids[kind as keyof typeof ids],
      runId: params.runId,
      ticker: params.ticker,
      source: params.source,
      sourceType: 'mock',
      contentHash: 'a'.repeat(64),
      retrievedAt: params.acceptance.retrievedAt,
      validAt: null,
      data: params.data,
      provenance: params.acceptance.provenance,
      acceptance: params.acceptance,
      createdAt: '2026-09-26T00:00:01.000Z',
    } as unknown as Evidence;
    evidenceRows.push(evidence);
    return evidence;
  });
  const getManyByIdsForRun = vi.fn(async (_runId: string, requestedIds: string[]) =>
    evidenceRows.filter(evidence => requestedIds.includes(evidence.id)));
  const research = vi.fn(async (_request: ResearchRequest) => ({
    value: options.output ?? researcherOutput(),
    subagent: 'researcher',
    skills: [{ name: 'skills/source-research/SKILL.md', contentHash: 'b'.repeat(64) }],
    modelCall: {
      provider: 'mock',
      model: 'mock-researcher',
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      totalTokens: 30,
      latencyMs: 5,
      finishReason: 'stop',
    },
  } as unknown as SubagentResult<ResearcherOutput>));
  const saveStep = vi.fn(async (_params: Parameters<WorkflowTraceStore['saveStep']>[0]) => undefined);
  const recordModelCall = vi.fn(async (_params: Parameters<WorkflowTraceStore['recordModelCall']>[0]) => undefined);
  const trace: WorkflowTraceStore = { saveStep, recordModelCall };
  const dependencies = {
    capabilityGateway: { invoke } as unknown as Pick<CapabilityGateway, 'invoke'>,
    evidence: { accept, getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'accept' | 'getManyByIdsForRun'>,
    researcher: { research },
    trace,
  } as unknown as ResearchWorkflowRuntimeDependencies;
  return { dependencies, invoke, invocations, accept, evidenceKinds, evidenceRows, getManyByIdsForRun, research, saveStep, recordModelCall };
}

describe('Research workflow runtime', () => {
  it('acquires, persists, grounds, traces, and returns one canonical report', async () => {
    const deps = harness();
    const controller = new AbortController();
    const onToolEvent = vi.fn();
    const workflowEvents: string[] = [];
    const result = await runResearchWorkflowRuntime({
      run,
      question,
      dependencies: deps.dependencies,
      signal: controller.signal,
      onToolEvent,
      onWorkflowEvent: event => workflowEvents.push(event.type + ':' + event.nodeId),
    });

    expect(result.acquisition.evidenceIds).toEqual([
      ids.company_report, ids.quarterly_financials, ids.news, ids.filings,
    ]);
    expect(result.acquisition.coverage).toEqual([
      { source: 'company_report', status: 'available', evidenceIds: [ids.company_report] },
      { source: 'quarterly_financials', status: 'available', evidenceIds: [ids.quarterly_financials] },
      { source: 'news', status: 'available', evidenceIds: [ids.news] },
      { source: 'filings', status: 'available', evidenceIds: [ids.filings] },
      { source: 'daily_transaction', status: 'not_requested' },
      { source: 'foreign_flow', status: 'not_requested' },
      { source: 'sentiment', status: 'not_requested' },
    ]);
    expect(ResearchReportPayloadSchema.safeParse(result.report).success).toBe(true);
    expect(result.report).toMatchObject<Partial<ResearchReportPayload>>({ question, summary: 'Quarterly revenue reached 3,000,000 in Q2 2026.' });
    expect(result.grounded.findings[0]?.citedFigures?.[0]?.periodLabel).toBe('Q2 2026');
    expect(deps.research).toHaveBeenCalledTimes(1);
    expect(deps.research).toHaveBeenCalledWith({
      ticker: run.ticker,
      question,
      evidenceZone: result.acquisition.evidenceZone,
    });
    expect(deps.invoke).toHaveBeenCalledTimes(4);
    expect(deps.invoke.mock.calls.map(call => call[1])).toEqual([
      financialToolIds.companyReport,
      financialToolIds.quarterlyFinancials,
      financialToolIds.news,
      financialToolIds.filings,
    ]);
    expect(deps.invoke.mock.calls.map(call => call[3]?.signal)).toEqual(Array(4).fill(controller.signal));
    expect(deps.invoke.mock.calls.map(call => call[3]?.onEvent)).toEqual(Array(4).fill(onToolEvent));
    expect(deps.invoke.mock.calls.map(call => call[0].id)).toEqual([
      'workflow.research.identify-company',
      'workflow.research.fetch-financials',
      'workflow.research.fetch-news',
      'workflow.research.fetch-news',
    ]);
    expect(deps.recordModelCall).toHaveBeenCalledTimes(1);
    expect(new Set(deps.saveStep.mock.calls.map(call => call[0].nodeId))).toEqual(new Set([
      'identify-company', 'fetch-financials', 'fetch-news', 'fetch-filings',
      'collect-evidence', 'synthesize-research', 'ground-research', 'build-report',
    ]));
    expect(workflowEvents).toContain('workflow.step.completed:build-report');
    expect(deps.invoke.mock.calls.flatMap(call => [call[1]]))
      .not.toContain('financial.daily-transaction');
    expect(deps.invoke.mock.calls.flatMap(call => [call[1]]))
      .not.toContain('financial.foreign-flow');
    expect(deps.invoke.mock.calls.flatMap(call => [call[1]]))
      .not.toContain('financial.sentiment');
    expect(deps.invoke.mock.calls.flatMap(call => [call[1]]))
      .not.toContain('financial.screen');
  });

  it('preflights both required provider results before the first Evidence write', async () => {
    const deps = harness({ malformedQuarterly: true });
    await expect(runResearchWorkflowRuntime({ run, question, dependencies: deps.dependencies }))
      .rejects.toMatchObject({ nodeId: 'collect-evidence' });
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.research).not.toHaveBeenCalled();
  });

  it('continues to Filings after a News provider failure and degrades only News', async () => {
    const deps = harness({ failProvider: 'news' });
    const events: Array<{ type: string; nodeId: string; required?: boolean }> = [];
    const result = await runResearchWorkflowRuntime({
      run, question, dependencies: deps.dependencies,
      onWorkflowEvent: event => events.push(event),
    });
    expect(deps.invoke.mock.calls.map(call => call[1])).toEqual([
      financialToolIds.companyReport,
      financialToolIds.quarterlyFinancials,
      financialToolIds.news,
      financialToolIds.filings,
    ]);
    expect(result.acquisition.coverage.find(item => item.source === 'news'))
      .toEqual({ source: 'news', status: 'unavailable', reason: 'NETWORK' });
    expect(result.acquisition.coverage.find(item => item.source === 'filings'))
      .toEqual({ source: 'filings', status: 'available', evidenceIds: [ids.filings] });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'workflow.step.failed', nodeId: 'fetch-news', required: false,
    }));
    expect(deps.saveStep).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'fetch-news', status: 'failed' }));
    expect(deps.research).toHaveBeenCalledTimes(1);
  });

  it('keeps News when the Filings provider fails', async () => {
    const deps = harness({ failProvider: 'filings' });
    const result = await runResearchWorkflowRuntime({ run, question, dependencies: deps.dependencies });
    expect(result.acquisition.coverage.find(item => item.source === 'news'))
      .toEqual({ source: 'news', status: 'available', evidenceIds: [ids.news] });
    expect(result.acquisition.coverage.find(item => item.source === 'filings'))
      .toEqual({ source: 'filings', status: 'unavailable', reason: 'TIMEOUT' });
  });

  it('degrades malformed News while persisting valid Filings', async () => {
    const deps = harness({ malformedNews: true });
    const result = await runResearchWorkflowRuntime({ run, question, dependencies: deps.dependencies });
    expect(deps.evidenceKinds).toEqual(['company_report', 'quarterly_financials', 'filings']);
    expect(result.acquisition.coverage.find(item => item.source === 'news'))
      .toEqual({ source: 'news', status: 'unavailable', reason: 'FINANCIAL_DATA_VERIFICATION_FAILED' });
    expect(result.acquisition.coverage.find(item => item.source === 'filings'))
      .toEqual({ source: 'filings', status: 'available', evidenceIds: [ids.filings] });
  });

  it('fails required collection when optional Evidence persistence fails', async () => {
    const deps = harness({ failedAcceptKind: 'news' });
    const workflowEvents: Array<{ type: string; nodeId: string; required?: boolean }> = [];
    await expect(runResearchWorkflowRuntime({
      run, question, dependencies: deps.dependencies,
      onWorkflowEvent: event => workflowEvents.push(event),
    })).rejects.toMatchObject({ nodeId: 'collect-evidence' });
    expect(deps.accept).toHaveBeenCalledTimes(3);
    expect(deps.research).not.toHaveBeenCalled();
    expect(workflowEvents).toContainEqual(expect.objectContaining({
      type: 'workflow.step.failed', nodeId: 'collect-evidence', required: true,
    }));
  });

  it('fails when either required Evidence persistence write fails', async () => {
    for (const kind of ['company_report', 'quarterly_financials'] as const) {
      const deps = harness({ failedAcceptKind: kind });
      await expect(runResearchWorkflowRuntime({ run, question, dependencies: deps.dependencies }))
        .rejects.toMatchObject({ nodeId: 'collect-evidence' });
      expect(deps.research).not.toHaveBeenCalled();
    }
  });

  it('rejects Researcher citations outside the acquired Evidence set', async () => {
    const deps = harness({ output: researcherOutput(ids.outside) });
    await expect(runResearchWorkflowRuntime({ run, question, dependencies: deps.dependencies }))
      .rejects.toMatchObject({ nodeId: 'ground-research' });
    expect(deps.research).toHaveBeenCalledTimes(1);
    expect(deps.getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('checks identity and question before source invocation', async () => {
    const deps = harness();
    for (const input of [
      { run: { id: ' ', ticker: 'BBRI' }, question },
      { run: { id: run.id, ticker: ' ' }, question },
      { run, question: ' ' },
    ]) {
      await expect(runResearchWorkflowRuntime({
        ...input,
        dependencies: deps.dependencies,
      } as Parameters<typeof runResearchWorkflowRuntime>[0])).rejects.toThrow();
    }
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('does not invoke the first capability when already aborted', async () => {
    const deps = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(runResearchWorkflowRuntime({
      run, question, dependencies: deps.dependencies, signal: controller.signal,
    })).rejects.toBeDefined();
    expect(deps.invoke).not.toHaveBeenCalled();
  });

  it('keeps the runtime headless and outside persistence or lifecycle adapters', () => {
    const runtime = readFileSync(new URL('../src/research/workflowRuntime.ts', import.meta.url), 'utf8');
    expect(runtime).not.toMatch(/apps\/cli|FinharnessDatabase|openDb|ConversationController|Ink|process\.stdout/);
    expect(runtime).not.toMatch(/FinancialDataProvider|SectorsClient|new ToolRuntime|FinancialSnapshot|createExecution|completeAndPublish/);
    expect(runtime).not.toMatch(/FinHarness|Finharness|FINHARNESS|HarnessContext/);
  });
});
