import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityGateway } from '@harness/capability';
import { COMPARE_NODE_IDS } from '@harness/command-compare';
import type { EvidenceStore } from '@harness/evidence';
import type { CompanyReport, FinancialDataMetadata, FinancialDataResult, QuarterlyFinancials } from '@harness/financial-data';
import { ComparisonMatrixSchema, ComparisonReportPayloadSchema, type Evidence } from '@harness/schemas';
import type { ToolRuntimeEvent } from '@harness/tool-runtime';
import type { WorkflowEvent } from '@harness/command-core';
import type { WorkflowTraceStore } from '../src/index.js';

const evidencePolicyState = vi.hoisted(() => ({ rejectionReason: '' }));
vi.mock('../src/financialEvidence.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/financialEvidence.js')>();
  const verifyAndPersist = original.verifyAndPersistFinancialEvidence as (...args: unknown[]) => Promise<unknown>;
  return {
    ...original,
    verifyAndPersistFinancialEvidence: async (...args: unknown[]) => {
      if (evidencePolicyState.rejectionReason) {
        return { accepted: false, policyId: 'evidence-policy-v1', reason: evidencePolicyState.rejectionReason };
      }
      return await verifyAndPersist(...args);
    },
  };
});

const normalizationState = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('../src/compare/normalization.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/compare/normalization.js')>();
  return {
    ...original,
    normalizeComparisonEvidence: async (params: Parameters<typeof original.normalizeComparisonEvidence>[0]) => {
      normalizationState.calls.push(params);
      return await original.normalizeComparisonEvidence(params);
    },
  };
});

import {
  COMPARE_CAPABILITY_PRINCIPALS,
  runComparisonWorkflowRuntime,
} from '../src/index.js';

const executionId = 'execution-compare-runtime';
const IDs = {
  BBCA: { company: '11111111-1111-4111-8111-111111111111', quarterly: '22222222-2222-4222-8222-222222222222' },
  BBRI: { company: '33333333-3333-4333-8333-333333333333', quarterly: '44444444-4444-4444-8444-444444444444' },
  BMRI: { company: '55555555-5555-4555-8555-555555555555', quarterly: '66666666-6666-4666-8666-666666666666' },
} as const;
type Ticker = keyof typeof IDs;

const metadata = (kind: 'company_report' | 'quarterly_financials'): FinancialDataMetadata => ({
  providerId: 'test-provider',
  source: `test.${kind}`,
  origin: 'MOCK',
  fetchedAt: null,
  dataAsOf: null,
  requestedAsOf: null,
  period: kind === 'quarterly_financials' ? '2025-Q4' : null,
  derivedFrom: [],
});

function companyReport(ticker: Ticker): FinancialDataResult<CompanyReport> {
  return {
    data: { ticker, name: `${ticker} Corp`, sector: 'Banking', asOf: '2025-12-31', financials: {}, valuation: {} },
    metadata: metadata('company_report'),
  };
}

function quarterlyFinancials(ticker: Ticker, index: number): FinancialDataResult<QuarterlyFinancials> {
  return {
    data: {
      ticker,
      quarters: [{
        period: '2025-Q4',
        periodType: 'single_quarter',
        revenue: 100 + index,
        netIncome: 20 + index,
        revenueGrowthYoy: 10 + index,
        netIncomeGrowthYoy: 4 + index,
        growthBasis: {
          revenueGrowthYoy: {
            status: 'proven', method: 'same_quarter_prior_year', period: '2025-Q4',
            comparisonPeriod: '2024-Q4', periodType: 'single_quarter', unit: 'percent',
          },
          netIncomeGrowthYoy: index === 0
            ? { status: 'unproven', reason: 'COMPANY_REPORT_PERIOD_UNVERIFIED' }
            : {
                status: 'proven', method: 'same_quarter_prior_year', period: '2025-Q4',
                comparisonPeriod: '2024-Q4', periodType: 'single_quarter', unit: 'percent',
              },
        },
      }],
    },
    metadata: metadata('quarterly_financials'),
  };
}

function runtimeFixture(tickers: readonly Ticker[], options: {
  failAt?: (capabilityId: string, ticker: string) => unknown;
  badQuarterTicker?: string;
  acceptFailure?: Error;
  lookupFailure?: Error;
} = {}) {
  const normalizedTickers = [...tickers];
  const events: Array<{ principalId: string; capabilityId: string; ticker: string; signal?: AbortSignal; onEvent?: (event: ToolRuntimeEvent) => void }> = [];
  const rows: Evidence[] = [];
  let quarterlyIndex = 0;
  const invoke = vi.fn(async (principal: { id: string }, capabilityId: string, input: { ticker: string }, invocation?: {
    signal?: AbortSignal;
    onEvent?: (event: ToolRuntimeEvent) => void;
  }) => {
    events.push({ principalId: principal.id, capabilityId, ticker: input.ticker, signal: invocation?.signal, onEvent: invocation?.onEvent });
    const failure = options.failAt?.(capabilityId, input.ticker);
    if (failure) throw failure;
    if (capabilityId === 'financial.company-report') {
      return { value: companyReport(input.ticker as Ticker) };
    }
    const result = quarterlyFinancials(input.ticker as Ticker, quarterlyIndex++);
    if (input.ticker === options.badQuarterTicker) result.data.ticker = 'NOPE';
    return { value: result };
  });
  const accept = vi.fn(async (params: {
    runId: string;
    ticker: string;
    source: string;
    data: Record<string, unknown>;
    acceptance: { provenance: Record<string, unknown> };
  }) => {
    if (options.acceptFailure) throw options.acceptFailure;
    const ticker = params.ticker as Ticker;
    const id = params.source.endsWith('quarterly_financials') ? IDs[ticker].quarterly : IDs[ticker].company;
    const item = {
      id,
      runId: params.runId,
      ticker,
      source: params.source,
      sourceType: 'mock' as const,
      contentHash: 'a'.repeat(64),
      retrievedAt: '2026-09-25T00:00:00.000Z',
      data: params.data,
      provenance: params.acceptance.provenance,
      acceptance: params.acceptance,
    } as Evidence;
    rows.push(item);
    return item;
  });
  const getManyByIdsForRun = vi.fn(async (runId: string, ids: string[]) => {
    if (options.lookupFailure) throw options.lookupFailure;
    return rows.filter(item => item.runId === runId && ids.includes(item.id));
  });
  const evidence = { accept, getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'accept' | 'getManyByIdsForRun'>;
  const saveStep = vi.fn(async (_params: Parameters<WorkflowTraceStore['saveStep']>[0]) => undefined);
  const recordModelCall = vi.fn(async (_params: Parameters<WorkflowTraceStore['recordModelCall']>[0]) => undefined);
  const listModelCallsForStep = vi.fn(async () => []);
  const trace = { saveStep, recordModelCall, listModelCallsForStep } as unknown as WorkflowTraceStore;
  return {
    events,
    rows,
    invoke,
    accept,
    getManyByIdsForRun,
    saveStep,
    recordModelCall,
    listModelCallsForStep,
    evidence,
    runtime: {
      run: { id: executionId, ticker: normalizedTickers[0] ?? '' },
      subjects: normalizedTickers,
      dependencies: { capabilityGateway: { invoke } as unknown as Pick<CapabilityGateway, 'invoke'>, evidence, trace },
    },
  };
}

describe('comparison workflow runtime', () => {
  it.each([
    ['two subjects', ['BBCA', 'BBRI'] as const],
    ['three subjects', ['BBCA', 'BBRI', 'BMRI'] as const],
  ])('acquires, verifies, normalizes, and builds a schema-v1 report for %s in order', async (_label, tickers) => {
    const fixture = runtimeFixture(tickers);
    normalizationState.calls.length = 0;
    const controller = new AbortController();
    const onToolEvent = vi.fn<(event: ToolRuntimeEvent) => void>();
    const workflowEvents: WorkflowEvent[] = [];
    const onWorkflowEvent = vi.fn((event: WorkflowEvent) => { workflowEvents.push(event); });
    const result = await runComparisonWorkflowRuntime({
      ...fixture.runtime,
      signal: controller.signal,
      onWorkflowEvent,
      onToolEvent,
    });

    expect(fixture.events.map(({ principalId, capabilityId, ticker }) => [principalId, capabilityId, ticker])).toEqual([
      ...tickers.map(ticker => [COMPARE_CAPABILITY_PRINCIPALS.identifySubjects.id, 'financial.company-report', ticker]),
      ...tickers.map(ticker => [COMPARE_CAPABILITY_PRINCIPALS.fetchFinancials.id, 'financial.quarterly-financials', ticker]),
    ]);
    expect(fixture.events.every(event => event.signal === controller.signal && event.onEvent === onToolEvent)).toBe(true);
    expect(fixture.accept.mock.calls.map(([params]) => [params.ticker, params.source.endsWith('quarterly_financials') ? 'quarterly' : 'company'])).toEqual(
      tickers.flatMap(ticker => [[ticker, 'company'], [ticker, 'quarterly']]),
    );
    expect(result.acquisition.evidence.map(item => item.id)).toEqual(tickers.flatMap(ticker => [IDs[ticker].company, IDs[ticker].quarterly]));
    expect(result.acquisition.sources).toEqual(tickers.map(ticker => ({
      ticker,
      companyReportEvidenceId: IDs[ticker].company,
      quarterlyFinancialsEvidenceId: IDs[ticker].quarterly,
    })));
    expect(fixture.getManyByIdsForRun).toHaveBeenCalledTimes(1);
    expect(fixture.getManyByIdsForRun).toHaveBeenCalledWith(executionId, tickers.flatMap(ticker => [IDs[ticker].company, IDs[ticker].quarterly]));
    expect(normalizationState.calls).toHaveLength(1);
    expect(normalizationState.calls[0]).toMatchObject({
      executionId,
      subjects: tickers,
      sources: tickers.map(ticker => ({
        ticker,
        companyReportEvidenceId: IDs[ticker].company,
        quarterlyFinancialsEvidenceId: IDs[ticker].quarterly,
      })),
      signal: controller.signal,
      evidenceStore: fixture.evidence,
    });
    expect(result.matrix.subjects.map(subject => subject.ticker)).toEqual(tickers);
    expect(result.matrix.metrics.map(metric => metric.status)).toEqual(['comparable', 'unavailable']);
    expect(result.matrix.metrics[1]?.cells.some(cell => cell.status === 'unavailable')).toBe(true);
    expect(result.report).toEqual(result.matrix);
    expect(result.report).not.toHaveProperty('narrative');
    expect(ComparisonMatrixSchema.parse(result.matrix)).toEqual(result.matrix);
    expect(ComparisonReportPayloadSchema.parse(result.report)).toEqual(result.report);
    expect(fixture.saveStep.mock.calls.map(([params]) => params.nodeId).filter((id, index, all) => all.indexOf(id) === index))
      .toEqual([...COMPARE_NODE_IDS]);
    expect(workflowEvents.filter(event => event.type === 'workflow.step.completed').map(event => event.nodeId))
      .toEqual([...COMPARE_NODE_IDS]);
    expect(fixture.recordModelCall).not.toHaveBeenCalled();
    expect(fixture.listModelCallsForStep).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'blank execution id', run: { id: '  ', ticker: 'BBCA' }, subjects: ['BBCA', 'BBRI'] },
    { label: 'one subject', run: { id: executionId, ticker: 'BBCA' }, subjects: ['BBCA'] },
    { label: 'four subjects', run: { id: executionId, ticker: 'BBCA' }, subjects: ['BBCA', 'BBRI', 'BMRI', 'ADRO'] },
    { label: 'invalid IDX ticker', run: { id: executionId, ticker: 'BBCA' }, subjects: ['BBCA', 'BB-RI'] },
    { label: 'duplicate subjects', run: { id: executionId, ticker: 'BBCA' }, subjects: ['BBCA', ' bbca '] },
    { label: 'anchor mismatch', run: { id: executionId, ticker: 'BBRI' }, subjects: ['BBCA', 'BBRI'] },
  ])('rejects $label before any provider, Evidence, or trace operation', async ({ run, subjects }) => {
    const fixture = runtimeFixture(['BBCA', 'BBRI']);
    await expect(runComparisonWorkflowRuntime({ ...fixture.runtime, run, subjects })).rejects.toThrow();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(fixture.accept).not.toHaveBeenCalled();
    expect(fixture.getManyByIdsForRun).not.toHaveBeenCalled();
    expect(fixture.saveStep).not.toHaveBeenCalled();
  });

  it('normalizes subjects but requires the Execution ticker to equal the first normalized subject', async () => {
    const fixture = runtimeFixture(['BBCA', 'BBRI']);
    const result = await runComparisonWorkflowRuntime({
      ...fixture.runtime,
      run: { ...fixture.runtime.run, ticker: 'BBCA' },
      subjects: [' bbca ', ' bbri '],
    });
    expect(result.matrix.subjects.map(subject => subject.ticker)).toEqual(['BBCA', 'BBRI']);
  });

  it('stops downstream work after a provider failure and preserves the provider cause', async () => {
    const providerFailure = new Error('quarterly provider failed');
    const fixture = runtimeFixture(['BBCA', 'BBRI'], {
      failAt: (capabilityId, ticker) => capabilityId === 'financial.quarterly-financials' && ticker === 'BBRI' ? providerFailure : undefined,
    });
    const workflowEvents: WorkflowEvent[] = [];
    await expect(runComparisonWorkflowRuntime({
      ...fixture.runtime,
      onWorkflowEvent: event => { workflowEvents.push(event); },
    })).rejects.toMatchObject({ name: 'WorkflowStepError', cause: providerFailure });
    expect(fixture.accept).not.toHaveBeenCalled();
    expect(fixture.getManyByIdsForRun).not.toHaveBeenCalled();
    expect(workflowEvents.some(event => event.type === 'workflow.step.failed' && event.nodeId === 'fetch-financials')).toBe(true);
    expect(workflowEvents.some(event => event.type === 'workflow.step.started' && event.nodeId === 'collect-evidence')).toBe(false);
  });

  it('verifies every company and quarterly response before the first Evidence write', async () => {
    const fixture = runtimeFixture(['BBCA', 'BBRI'], { badQuarterTicker: 'BBRI' });
    await expect(runComparisonWorkflowRuntime(fixture.runtime)).rejects.toMatchObject({
      name: 'WorkflowStepError',
      nodeId: 'collect-evidence',
      cause: expect.objectContaining({ name: 'FinancialDataVerificationError' }),
    });
    expect(fixture.accept).not.toHaveBeenCalled();
    expect(fixture.getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('fails collection when Evidence acceptance fails and retains its cause', async () => {
    const storeFailure = new Error('evidence store unavailable');
    const fixture = runtimeFixture(['BBCA', 'BBRI'], { acceptFailure: storeFailure });
    await expect(runComparisonWorkflowRuntime(fixture.runtime)).rejects.toMatchObject({
      name: 'WorkflowStepError', nodeId: 'collect-evidence', cause: storeFailure,
    });
    expect(fixture.accept).toHaveBeenCalledTimes(1);
    expect(fixture.getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('fails collection when Evidence policy rejects a required source', async () => {
    const fixture = runtimeFixture(['BBCA', 'BBRI']);
    evidencePolicyState.rejectionReason = 'FINANCIAL_VERIFICATION_FAILED';
    try {
      await expect(runComparisonWorkflowRuntime(fixture.runtime)).rejects.toMatchObject({
        name: 'WorkflowStepError',
        nodeId: 'collect-evidence',
        cause: expect.objectContaining({
          message: 'Evidence policy rejected required Comparison source company_report',
          cause: { policyId: 'evidence-policy-v1', reason: 'FINANCIAL_VERIFICATION_FAILED' },
        }),
      });
    } finally {
      evidencePolicyState.rejectionReason = '';
    }
    expect(fixture.accept).not.toHaveBeenCalled();
    expect(fixture.getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('keeps normalization lookup causes under the required workflow step error', async () => {
    const lookupFailure = new Error('scoped evidence lookup unavailable');
    const fixture = runtimeFixture(['BBCA', 'BBRI'], { lookupFailure });
    await expect(runComparisonWorkflowRuntime(fixture.runtime)).rejects.toMatchObject({
      name: 'WorkflowStepError',
      nodeId: 'normalize-comparison',
      cause: expect.objectContaining({
        name: 'ComparisonNormalizationError',
        code: 'VALIDATION_UNAVAILABLE',
        cause: lookupFailure,
      }),
    });
    expect(fixture.getManyByIdsForRun).toHaveBeenCalledTimes(1);
  });

  it('stops provider calls on pre-abort and on cancellation between provider calls', async () => {
    normalizationState.calls.length = 0;
    const preAborted = runtimeFixture(['BBCA', 'BBRI']);
    const before = new AbortController();
    const beforeReason = new Error('cancel before start');
    before.abort(beforeReason);
    await expect(runComparisonWorkflowRuntime({ ...preAborted.runtime, signal: before.signal })).rejects.toBe(beforeReason);
    expect(preAborted.invoke).not.toHaveBeenCalled();
    expect(preAborted.saveStep).not.toHaveBeenCalled();

    const during = runtimeFixture(['BBCA', 'BBRI']);
    const controller = new AbortController();
    const reason = new Error('cancel after first provider response');
    during.invoke.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { value: companyReport('BBCA') } as never;
    });
    await expect(runComparisonWorkflowRuntime({ ...during.runtime, signal: controller.signal })).rejects.toBe(reason);
    expect(during.invoke).toHaveBeenCalledTimes(1);
    expect(during.accept).not.toHaveBeenCalled();
    expect(during.getManyByIdsForRun).not.toHaveBeenCalled();
    expect(normalizationState.calls).toHaveLength(0);
  });

  it('keeps the runtime headless and outside lifecycle, CLI, context, and publication ownership', () => {
    const source = readFileSync(new URL('../src/compare/workflowRuntime.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/@harness\/(session-core|database|context|conversation|execution)/);
    expect(source).not.toMatch(/HarnessContext|runSessionTurn|createExecution|settleExecution|publish.*Artifact|WorkingContext/);
  });
});
