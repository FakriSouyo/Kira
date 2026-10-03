import { describe, expect, it, vi } from 'vitest';
import { canonicalHash, EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID, type EvidenceStore } from '@harness/evidence';
import { verifyFinancialObservation } from '@harness/financial-data';
import type { Evidence } from '@harness/schemas';

const executionId = 'execution-challenge-1';
const foreignExecutionId = 'execution-challenge-2';
const reportId = '11111111-1111-4111-8111-111111111111';
const priorReportId = '22222222-2222-4222-8222-222222222222';
const quarterlyId = '33333333-3333-4333-8333-333333333333';
const thesis = 'BBCA can sustain its current profitability.';

function acceptedEvidence(params: {
  id: string;
  kind: 'company_report' | 'quarterly_financials';
  data: Record<string, unknown>;
  source: string;
  asOf: string;
  runId?: string;
}): Evidence {
  const metadata = {
    providerId: 'test-provider',
    source: params.source,
    origin: 'MOCK' as const,
    fetchedAt: '2025-12-01T00:00:00.000Z',
    dataAsOf: params.asOf,
    requestedAsOf: null,
    period: null,
    derivedFrom: [],
  };
  const verification = params.kind === 'company_report'
    ? verifyFinancialObservation('company_report', { data: params.data as never, metadata }, 'BBCA').verification
    : verifyFinancialObservation('quarterly_financials', { data: params.data as never, metadata }, 'BBCA').verification;
  const provenance = { metadata, verification, observationKind: params.kind };
  return {
    id: params.id,
    runId: params.runId ?? executionId,
    ticker: 'BBCA',
    source: params.source,
    sourceType: 'mock',
    contentHash: canonicalHash(params.data),
    retrievedAt: metadata.fetchedAt,
    validAt: null,
    data: params.data,
    provenance,
    acceptance: {
      policyId: EVIDENCE_POLICY_ID,
      policyFingerprint: EVIDENCE_POLICY_FINGERPRINT,
      candidateKind: 'financial',
      sourceOrigin: metadata.origin,
      retrievedAt: metadata.fetchedAt,
      acceptedAt: '2025-12-02T00:00:00.000Z',
      validAt: null,
      provenance,
    },
  };
}

function report(id = reportId, asOf = '2025-12-31', roe = 22.4): Evidence {
  return acceptedEvidence({
    id,
    kind: 'company_report',
    source: 'sectors.company_report',
    asOf,
    data: {
      ticker: 'BBCA',
      asOf,
      financials: {
        roe,
        roa: 7.5,
        netMargin: 12.5,
        grossMargin: 35,
        debtToEquity: 0,
        currentRatio: 1.3,
        yoyQuarterRevenueGrowth: 8,
        yoyQuarterEarningsGrowth: 4,
      },
      valuation: { price: 100, pe: 12, pb: 2, dividendYield: 3 },
    },
  });
}

function quarterly(): Evidence {
  return acceptedEvidence({
    id: quarterlyId,
    kind: 'quarterly_financials',
    source: 'sectors.quarterly_financials',
    asOf: '2025-12-31',
    data: {
      ticker: 'BBCA',
      currency: 'IDR',
      quarters: [{ period: '2025-Q4', revenue: 1_000_000, netIncome: 200_000, revenueGrowthYoy: 8, netIncomeGrowthYoy: 4 }],
    },
  });
}

function analystOutput(params: {
  statement?: string;
  evidenceIds?: string[];
  citedFigures?: Array<{ evidenceId: string; path: string; value: number; periodLabel: string }>;
  coverageSource?: string;
} = {}) {
  const evidenceIds = params.evidenceIds ?? [reportId];
  return {
    thesis,
    summary: 'The report supports profitability, while future margins may weaken.',
    supportingCase: [{
      statement: params.statement ?? 'ROE was 22.4%.',
      evidenceIds,
      confidence: 'high',
      citedFigures: params.citedFigures ?? [{
        evidenceId: reportId,
        path: 'financials.roe',
        value: 22.4,
        periodLabel: '2025-12-31',
      }],
    }],
    counterCase: [],
    unsupportedAssumptions: ['Margins remain resilient.'],
    failureConditions: ['Persistent margin pressure would weaken the thesis.'],
    evidenceThatWouldChangeThesis: ['A later report showing margin compression.'],
    sourceAssessments: [{ evidenceId: reportId, quality: 'primary', rationale: 'Issuer report.' }],
    gaps: ['No later reporting period was supplied.'],
    coverage: [{ source: params.coverageSource ?? 'sectors.company_report', evidenceIds: [reportId] }],
  };
}

function createStore(items: Evidence[] = [report()]) {
  const getManyByIdsForRun = vi.fn(async (runId: string, ids: string[]) =>
    items.filter(item => item.runId === runId && ids.includes(item.id)));
  return { getManyByIdsForRun } as Pick<EvidenceStore, 'getManyByIdsForRun'> & {
    getManyByIdsForRun: typeof getManyByIdsForRun;
  };
}

function singleFigureOutput(params: {
  evidenceId: string;
  source: string;
  path: string;
  value: number;
  periodLabel: string;
  statement: string;
}) {
  const output = analystOutput({
    statement: params.statement,
    evidenceIds: [params.evidenceId],
    citedFigures: [{
      evidenceId: params.evidenceId,
      path: params.path,
      value: params.value,
      periodLabel: params.periodLabel,
    }],
  });
  output.sourceAssessments = [{ evidenceId: params.evidenceId, quality: 'primary', rationale: 'Primary source.' }];
  output.coverage = [{ source: params.source, evidenceIds: [params.evidenceId] }];
  return output;
}

async function ground(params: {
  evidence?: Evidence[];
  output?: ReturnType<typeof analystOutput>;
  seenEvidenceIds?: string[];
  evidenceStore?: Pick<EvidenceStore, 'getManyByIdsForRun'>;
  signal?: AbortSignal;
} = {}) {
  const { groundChallengeOutput } = await import('../src/challenge/grounding.js');
  return groundChallengeOutput({
    executionId,
    ticker: 'BBCA',
    thesis,
    output: params.output ?? analystOutput(),
    seenEvidenceIds: params.seenEvidenceIds ?? [reportId],
    evidenceStore: params.evidenceStore ?? createStore(params.evidence),
    signal: params.signal,
  });
}

describe('groundChallengeOutput', () => {
  it.each([
    'Evidence is mixed. Buy.',
    'Risk remains elevated. Sell now.',
    'The thesis remains uncertain. Hold it.',
  ])('rejects an embedded standalone transaction directive: %s', async (summary) => {
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.summary = summary;

    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('validates current Evidence once in Execution scope and derives figure semantics from its path', async () => {
    const reportEvidence = report();
    const quarterlyEvidence = quarterly();
    const store = createStore([reportEvidence, quarterlyEvidence]);
    const output = analystOutput({
      statement: 'ROE was 22.4%.',
      evidenceIds: [reportId, quarterlyId],
      citedFigures: [
        { evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' },
        { evidenceId: quarterlyId, path: 'quarters[0].revenue', value: 1_000_000, periodLabel: '2025-Q4' },
      ],
    });
    output.sourceAssessments.push({ evidenceId: quarterlyId, quality: 'primary', rationale: 'Quarterly filing.' });
    output.coverage.push({ source: 'sectors.quarterly_financials', evidenceIds: [quarterlyId] });

    const { groundChallengeOutput } = await import('../src/challenge/grounding.js');
    const result = await groundChallengeOutput({
      executionId,
      ticker: 'BBCA',
      thesis,
      output,
      seenEvidenceIds: [reportId, quarterlyId],
      evidenceStore: store,
    });

    expect(result.supportingCase[0]!.citedFigures).toEqual([
      { evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31', metric: 'roe', unitClass: 'percent' },
      { evidenceId: quarterlyId, path: 'quarters[0].revenue', value: 1_000_000, periodLabel: '2025-Q4', metric: 'revenue', unitClass: 'currency', currencyCode: 'IDR' },
    ]);
    expect(result.coverage).toEqual([
      { source: 'sectors.company_report', evidenceIds: [reportId] },
      { source: 'sectors.quarterly_financials', evidenceIds: [quarterlyId] },
    ]);
    expect(store.getManyByIdsForRun).toHaveBeenCalledTimes(1);
    expect(store.getManyByIdsForRun).toHaveBeenCalledWith(executionId, [reportId, quarterlyId]);
  });

  it('rejects Evidence returned from another Execution', async () => {
    const foreign = report();
    foreign.runId = foreignExecutionId;
    await expect(ground({ evidence: [foreign] })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
  });

  it('rejects raw data whose persisted canonical hash no longer matches', async () => {
    const tampered = report();
    tampered.contentHash = '0'.repeat(64);
    await expect(ground({ evidence: [tampered] })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
  });

  it('rejects stale or legacy acceptance and inconsistent source type', async () => {
    const stale = report();
    stale.acceptance!.policyFingerprint = 'old-policy';
    await expect(ground({ evidence: [stale] })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });

    const wrongSourceType = report();
    wrongSourceType.sourceType = 'api';
    await expect(ground({ evidence: [wrongSourceType] })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
  });

  it('preserves the cause when the single Execution-scoped Evidence read fails', async () => {
    const cause = new Error('sqlite unavailable');
    const getManyByIdsForRun = vi.fn(async () => { throw cause; });
    let caught: unknown;
    try {
      await ground({ evidenceStore: { getManyByIdsForRun } as Pick<EvidenceStore, 'getManyByIdsForRun'> });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'VALIDATION_UNAVAILABLE' });
    expect((caught as Error & { cause?: unknown }).cause).toBe(cause);
    expect(getManyByIdsForRun).toHaveBeenCalledTimes(1);
    expect(getManyByIdsForRun).toHaveBeenCalledWith(executionId, [reportId]);
  });

  it('rejects missing and duplicate rows returned by the scoped read', async () => {
    const missing = createStore([]);
    await expect(ground({ evidenceStore: missing })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });

    const row = report();
    const duplicate = { getManyByIdsForRun: vi.fn(async () => [row, row]) };
    await expect(ground({ evidenceStore: duplicate as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'> }))
      .rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
  });

  it('validates Execution identity, ticker, and supplied Evidence before a store lookup', async () => {
    const { groundChallengeOutput } = await import('../src/challenge/grounding.js');
    const getManyByIdsForRun = vi.fn(async () => []);
    const evidenceStore = { getManyByIdsForRun } as Pick<EvidenceStore, 'getManyByIdsForRun'>;
    const base = {
      ticker: 'BBCA',
      thesis,
      output: analystOutput(),
      seenEvidenceIds: [reportId],
      evidenceStore,
    };

    await expect(groundChallengeOutput({ ...base, executionId: '   ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(groundChallengeOutput({ ...base, executionId, ticker: 'bad ticker' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(groundChallengeOutput({ ...base, executionId, seenEvidenceIds: [] })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('rejects citation paths that cannot prove the supplied numeric value', async () => {
    const output = analystOutput({
      statement: 'ROE was 22.4%.',
      citedFigures: [{ evidenceId: reportId, path: 'valuation.pe', value: 22.4, periodLabel: '2025-12-31' }],
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects a period label that differs from the canonical report period', async () => {
    const output = analystOutput({
      citedFigures: [{ evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2024-12-31' }],
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects a numeric statement that does not match its cited figure', async () => {
    await expect(ground({ output: analystOutput({ statement: 'ROE was twenty-two point five percent.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('binds each numeric assertion to the metric named in the statement', async () => {
    await expect(ground({ output: analystOutput({ statement: 'ROA was 22.4%.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(ground({ output: analystOutput({ statement: 'It was 22.4%.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects unsupported rank claims even when a separate metric is cited', async () => {
    await expect(ground({ output: analystOutput({ statement: 'ROE ranked #1 at 22.4%.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects an implicit upper-bound assertion instead of treating it as an exact value', async () => {
    await expect(ground({ output: analystOutput({ statement: 'ROE was 22.4% or less.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(ground({ output: analystOutput({ statement: 'ROE was at most 22.4%.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects a coverage source alias that differs from Evidence.source', async () => {
    await expect(ground({ output: analystOutput({ coverageSource: 'company_report' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    ['roe', 'financials.roe', 22.4, 'ROE was 22.4%.', 'percent'],
    ['roa', 'financials.roa', 7.5, 'ROA was 7.5%.', 'percent'],
    ['netMargin', 'financials.netMargin', 12.5, 'Net margin was 12.5%.', 'percent'],
    ['grossMargin', 'financials.grossMargin', 35, 'Gross margin was 35%.', 'percent'],
    ['debtToEquity', 'financials.debtToEquity', 0, 'Debt-to-equity ratio was zero.', 'ratio'],
    ['currentRatio', 'financials.currentRatio', 1.3, 'Current ratio was 1.3.', 'ratio'],
    ['revenueGrowthYoy', 'financials.yoyQuarterRevenueGrowth', 8, 'Revenue growth was 8%.', 'percent'],
    ['netIncomeGrowthYoy', 'financials.yoyQuarterEarningsGrowth', 4, 'Net income growth was 4%.', 'percent'],
    ['price', 'valuation.price', 100, 'Price was 100.', 'nominal'],
    ['pe', 'valuation.pe', 12, 'P/E was 12x.', 'multiple'],
    ['pb', 'valuation.pb', 2, 'P/B was 2x.', 'multiple'],
    ['dividendYield', 'valuation.dividendYield', 3, 'Dividend yield was 3%.', 'percent'],
    ['revenue', 'quarters[0].revenue', 1_000_000, 'Revenue was IDR 1,000,000.', 'currency'],
    ['netIncome', 'quarters[0].netIncome', 200_000, 'Net income was IDR 200,000.', 'currency'],
  ])('derives %s and its unit from the canonical source path', async (metric, path, value, statement, unitClass) => {
    const isQuarterly = path.startsWith('quarters[');
    const item = isQuarterly ? quarterly() : report();
    const itemId = isQuarterly ? quarterlyId : reportId;
    const source = isQuarterly ? 'sectors.quarterly_financials' : 'sectors.company_report';
    const periodLabel = isQuarterly ? '2025-Q4' : '2025-12-31';
    const output = singleFigureOutput({ evidenceId: itemId, source, path, value, periodLabel, statement });
    const result = await ground({ output, evidence: [item], seenEvidenceIds: [itemId] });

    expect(result.supportingCase[0]!.citedFigures![0]).toMatchObject({ metric, unitClass });
    if (isQuarterly && unitClass === 'currency') {
      expect(result.supportingCase[0]!.citedFigures![0]!.currencyCode).toBe('IDR');
    }
  });

  it('binds spoken numeric assertion frames to the exact cited value', async () => {
    const output = analystOutput({ statement: 'The report lists ROE at twenty-two point four percent.' });
    await expect(ground({ output })).resolves.toMatchObject({
      supportingCase: [{ citedFigures: [{ value: 22.4, metric: 'roe', unitClass: 'percent' }] }],
    });
  });

  it('rejects rank assertions because rank is outside the financial metric contract', async () => {
    await expect(ground({ output: analystOutput({ statement: 'ROE ranked first at 22.4%.' }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('grounds exact zero and multiplier frames to ratio and multiple figures', async () => {
    const zero = singleFigureOutput({
      evidenceId: reportId,
      source: 'sectors.company_report',
      path: 'financials.debtToEquity',
      value: 0,
      periodLabel: '2025-12-31',
      statement: 'Debt-to-equity ratio is zero.',
    });
    const multiple = singleFigureOutput({
      evidenceId: reportId,
      source: 'sectors.company_report',
      path: 'valuation.pe',
      value: 12,
      periodLabel: '2025-12-31',
      statement: 'P/E is twelve times.',
    });

    await expect(ground({ output: zero })).resolves.toMatchObject({ supportingCase: [{ citedFigures: [{ metric: 'debtToEquity', unitClass: 'ratio' }] }] });
    await expect(ground({ output: multiple })).resolves.toMatchObject({ supportingCase: [{ citedFigures: [{ metric: 'pe', unitClass: 'multiple' }] }] });
  });

  it('checks change direction and comparison endpoints against distinct grounded periods', async () => {
    const prior = report(priorReportId, '2024-12-31', 20);
    const current = report();
    const output = analystOutput({
      statement: 'ROE rose from 20% to 22.4%.',
      evidenceIds: [priorReportId, reportId],
      citedFigures: [
        { evidenceId: priorReportId, path: 'financials.roe', value: 20, periodLabel: '2024-12-31' },
        { evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' },
      ],
    });
    output.sourceAssessments = [
      { evidenceId: priorReportId, quality: 'primary', rationale: 'Prior report.' },
      { evidenceId: reportId, quality: 'primary', rationale: 'Current report.' },
    ];
    output.coverage = [{ source: 'sectors.company_report', evidenceIds: [priorReportId, reportId] }];

    await expect(ground({ evidence: [prior, current], output, seenEvidenceIds: [priorReportId, reportId] }))
      .resolves.toMatchObject({ supportingCase: [{ citedFigures: [{ value: 20 }, { value: 22.4 }] }] });

    output.supportingCase[0]!.statement = 'ROE fell from 20% to 22.4%.';
    await expect(ground({ evidence: [prior, current], output, seenEvidenceIds: [priorReportId, reportId] }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'Net margin expanded to 12.5%.',
    'Net margin narrowed to 12.5%.',
  ])('rejects a one-endpoint net-margin change despite a matching figure: %s', async (statement) => {
    const output = singleFigureOutput({
      evidenceId: reportId,
      source: 'sectors.company_report',
      path: 'financials.netMargin',
      value: 12.5,
      periodLabel: '2025-12-31',
      statement,
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('rejects a one-endpoint currency revenue change despite a matching figure', async () => {
    const output = singleFigureOutput({
      evidenceId: quarterlyId,
      source: 'sectors.quarterly_financials',
      path: 'quarters[0].revenue',
      value: 1_000_000,
      periodLabel: '2025-Q4',
      statement: 'Revenue contracted to IDR 1000000.',
    });
    await expect(ground({ output, evidence: [quarterly()], seenEvidenceIds: [quarterlyId] }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('accepts a directional claim for a directly reported YoY growth figure', async () => {
    const output = singleFigureOutput({
      evidenceId: quarterlyId,
      source: 'sectors.quarterly_financials',
      path: 'quarters[0].revenueGrowthYoy',
      value: 8,
      periodLabel: '2025-Q4',
      statement: 'Revenue rose 8% YoY.',
    });
    await expect(ground({ output, evidence: [quarterly()], seenEvidenceIds: [quarterlyId] }))
      .resolves.toMatchObject({ supportingCase: [{ citedFigures: [{ metric: 'revenueGrowthYoy', value: 8 }] }] });
  });

  it.each([
    'The report supports profitability, though future margins may weaken.',
    'The quarterly record qualifies growth, yet later results may slow.',
    'As later results arrive, profitability could weaken.',
    'When another report is issued, margins might narrow.',
    'Once current reporting is complete, growth may cool.',
  ])('accepts a safe qualitative or future-condition continuation: %s', async (statement) => {
    const output = analystOutput({ statement, citedFigures: [] });
    await expect(ground({ output })).resolves.toMatchObject({ supportingCase: [{ statement }] });
  });

  it('rejects false currency assertions and implicit inequality bounds', async () => {
    const wrongCurrency = singleFigureOutput({
      evidenceId: quarterlyId,
      source: 'sectors.quarterly_financials',
      path: 'quarters[0].revenue',
      value: 1_000_000,
      periodLabel: '2025-Q4',
      statement: 'Revenue was USD 1,000,000.',
    });
    const ambiguousCurrency = singleFigureOutput({
      evidenceId: quarterlyId,
      source: 'sectors.quarterly_financials',
      path: 'quarters[0].revenue',
      value: 1_000_000,
      periodLabel: '2025-Q4',
      statement: 'Revenue was $1,000,000.',
    });
    const reportEvidence = report();
    const quarterEvidence = quarterly();
    const boundCases = [
      analystOutput({ statement: 'ROE was 22.4% or less.' }),
      analystOutput({ statement: 'ROE was at most 22.4%.' }),
    ];

    await expect(ground({ output: wrongCurrency, evidence: [quarterEvidence], seenEvidenceIds: [quarterlyId] }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(ground({ output: ambiguousCurrency, evidence: [quarterEvidence], seenEvidenceIds: [quarterlyId] }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    for (const output of boundCases) {
      await expect(ground({ output, evidence: [reportEvidence] })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    }
  });

  it('loads and validates every supplied Evidence even when a finding omits one', async () => {
    const supplied = report();
    const omitted = quarterly();
    omitted.contentHash = '0'.repeat(64);
    const store = createStore([supplied, omitted]);
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });

    await expect(ground({
      evidenceStore: store,
      output,
      seenEvidenceIds: [reportId, quarterlyId],
    })).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' });
    expect(store.getManyByIdsForRun).toHaveBeenCalledTimes(1);
    expect(store.getManyByIdsForRun).toHaveBeenCalledWith(executionId, [reportId, quarterlyId]);
  });

  it('requires source assessment and coverage for supplied Evidence omitted from findings', async () => {
    const first = report();
    const second = quarterly();
    const store = createStore([first, second]);
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });

    await expect(ground({
      evidenceStore: store,
      output,
      seenEvidenceIds: [reportId, quarterlyId],
    })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(store.getManyByIdsForRun).toHaveBeenCalledTimes(1);
    expect(store.getManyByIdsForRun).toHaveBeenCalledWith(executionId, [reportId, quarterlyId]);
  });

  it('allows a finding to cite a subset when every supplied Evidence is assessed and covered', async () => {
    const first = report();
    const second = quarterly();
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.sourceAssessments.push({ evidenceId: quarterlyId, quality: 'primary', rationale: 'Quarterly filing.' });
    output.coverage.push({ source: 'sectors.quarterly_financials', evidenceIds: [quarterlyId] });

    await expect(ground({
      evidence: [first, second],
      output,
      seenEvidenceIds: [reportId, quarterlyId],
    })).resolves.toMatchObject({ supportingCase: [{ evidenceIds: [reportId] }] });
  });

  it.each(['P/E 999.', 'Current ratio: 9.9.'])(
    'requires a grounded figure for an assertion-shaped metric number: %s',
    async (statement) => {
      await expect(ground({ output: analystOutput({ statement, citedFigures: [] }) }))
        .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    },
  );

  it('requires canonical units for percent and verified-currency figures', async () => {
    const roe = singleFigureOutput({
      evidenceId: reportId,
      source: 'sectors.company_report',
      path: 'financials.roe',
      value: 22.4,
      periodLabel: '2025-12-31',
      statement: 'ROE was 22.4.',
    });
    const revenue = singleFigureOutput({
      evidenceId: quarterlyId,
      source: 'sectors.quarterly_financials',
      path: 'quarters[0].revenue',
      value: 1_000_000,
      periodLabel: '2025-Q4',
      statement: 'Revenue was 1000000.',
    });

    await expect(ground({ output: roe })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(ground({ output: revenue, evidence: [quarterly()], seenEvidenceIds: [quarterlyId] }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'In 2025, the report notes ROE was 22.4%.',
    'For 2025-Q4, the report notes ROE was 22.4%.',
    '1. The report notes ROE was 22.4%.',
    'The report lists 3 points before noting ROE was 22.4%.',
  ])('does not treat dates, years, list numbers, or enumeration as metric claims: %s', async (statement) => {
    await expect(ground({ output: analystOutput({ statement }) })).resolves.toMatchObject({
      supportingCase: [{ statement }],
    });
  });

  it.each(['verdict', 'stance', 'bullish', 'bearish', 'winner', 'ranking', 'score', 'recommendation', 'target price', 'trade instruction'])(
    'rejects decision language in a finding: %s',
    async (term) => {
      await expect(ground({ output: analystOutput({ statement: `The analysis states ${term}.`, citedFigures: [] }) }))
        .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    },
  );

  it.each(['summary', 'unsupportedAssumptions', 'failureConditions', 'evidenceThatWouldChangeThesis', 'sourceAssessment rationale', 'gaps'])(
    'rejects standalone recommendation language in %s',
    async (field) => {
      const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
      const prohibited = 'The analyst should buy BBCA.';
      if (field === 'summary') output.summary = prohibited;
      else if (field === 'unsupportedAssumptions') output.unsupportedAssumptions = [prohibited];
      else if (field === 'failureConditions') output.failureConditions = [prohibited];
      else if (field === 'evidenceThatWouldChangeThesis') output.evidenceThatWouldChangeThesis = [prohibited];
      else if (field === 'sourceAssessment rationale') output.sourceAssessments[0]!.rationale = prohibited;
      else output.gaps = [prohibited];

      await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    },
  );

  it('does not reject unrelated words containing recommendation tokens', async () => {
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.summary = 'Sell-side estimates, buy-side expectations, shareholder communication, buyback activity, and holdings data remain contextual.';
    await expect(ground({ output })).resolves.toMatchObject({ summary: output.summary });
  });

  it.each(['Buy.', 'Sell.', 'Hold.', 'Buy now.', 'Sell now.', 'Hold now.', 'Buy it.', 'Sell it.', 'Hold it.'])(
    'rejects a standalone trade instruction in the summary: %s',
    async (instruction) => {
      const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
      output.summary = instruction;
      await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    },
  );

  it.each([
    'Sell-side estimates remain contextual.',
    'Buy-side expectations are background.',
    'Buyback activity remains relevant context.',
    'Holdings data are informative.',
  ])('allows research terminology in the summary: %s', async (summary) => {
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.summary = summary;
    await expect(ground({ output })).resolves.toMatchObject({ summary });
  });

  it('classifies unsupported and unavailable cited paths as analyst output errors', async () => {
    const unsupported = singleFigureOutput({
      evidenceId: reportId,
      source: 'sectors.company_report',
      path: 'financials.notAChallengeMetric',
      value: 22.4,
      periodLabel: '2025-12-31',
      statement: 'ROE was 22.4%.',
    });
    const unavailable = singleFigureOutput({
      evidenceId: quarterlyId,
      source: 'sectors.quarterly_financials',
      path: 'cumulativeYtd.revenueGrowthYoy',
      value: 8,
      periodLabel: '2025-Q4',
      statement: 'Revenue growth was 8%.',
    });

    await expect(ground({ output: unsupported })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    await expect(ground({ output: unavailable, evidence: [quarterly()], seenEvidenceIds: [quarterlyId] }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('does not read Evidence for a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const getManyByIdsForRun = vi.fn(async () => [report()]);

    await expect(ground({
      signal: controller.signal,
      evidenceStore: { getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('classifies a store rejection after cancellation as CANCELLED', async () => {
    const controller = new AbortController();
    const cause = new Error('store read cancelled');
    const getManyByIdsForRun = vi.fn(async () => {
      controller.abort();
      throw cause;
    });

    await expect(ground({
      signal: controller.signal,
      evidenceStore: { getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('checks cancellation after a successful Evidence read', async () => {
    const controller = new AbortController();
    const getManyByIdsForRun = vi.fn(async () => {
      controller.abort();
      return [report()];
    });

    await expect(ground({
      signal: controller.signal,
      evidenceStore: { getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it.each([
    'Profitability was approximately zero.',
    'ROE ranked roughly first.',
    'Profitability rose roughly fourfold.',
  ])('rejects a spoken quantitative or rank assertion with a qualifier: %s', async (statement) => {
    await expect(ground({ output: analystOutput({ statement, citedFigures: [] }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'The first quarter begins after the first section.',
    'Option one appears in chapter one.',
  ])('keeps ordinary ordinals and enumeration benign: %s', async (statement) => {
    await expect(ground({ output: analystOutput({ statement, citedFigures: [] }) }))
      .resolves.toMatchObject({ supportingCase: [{ statement }] });
  });

  it.each([
    'ROE ranked higher.',
    'ROE was ahead.',
    'ROE outperformed expectations.',
    'ROE led.',
    'ROE was dominant.',
  ])('rejects a targetless comparative continuation: %s', async (statement) => {
    await expect(ground({ output: analystOutput({ statement, citedFigures: [] }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'ROE was higher than the peer median.',
    'ROE was ahead of the industry norm.',
    'ROE outperformed the cohort.',
    'ROE was above the baseline.',
    'ROE beat the market.',
    'ROE was stronger than the sector.',
    'ROE exceeded consensus.',
    'ROE was below the index.',
  ])('rejects a comparative statement against an unsupported target: %s', async (statement) => {
    await expect(ground({ output: analystOutput({ statement, citedFigures: [] }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('does not let a grounded company figure support a detached relative comparison', async () => {
    const output = analystOutput({
      statement: 'ROE was 22.4%. ROE was higher than the peer median.',
      citedFigures: [{ evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' }],
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'ROE was 22.4%. This figure remains informative.',
    'ROE was 22.4%. This provides more context.',
    'ROE was 22.4%. This could change the thesis.',
  ])('accepts a benign qualitative continuation after a grounded figure: %s', async (statement) => {
    const output = analystOutput({
      statement,
      citedFigures: [{ evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' }],
    });
    await expect(ground({ output })).resolves.toMatchObject({ supportingCase: [{ statement }] });
  });

  it('accepts ordinary context that uses more without asserting a bound', async () => {
    const output = analystOutput({ statement: 'The report provides more context.', citedFigures: [] });
    await expect(ground({ output })).resolves.toMatchObject({ supportingCase: [{ statement: 'The report provides more context.' }] });
  });

  it.each([
    'When more data were available, ROE was higher.',
    'As more data accumulated, margins were stronger.',
    'ROE was higher, yet more data were available.',
    'ROE was higher, though more data accumulated.',
    'As current reporting proceeds, margins may narrow.',
    'Margins may have weakened.',
    'As later results arrive, ROE had risen.',
    'ROE was 22.4%. As later results arrive, margins had narrowed.',
  ])('rejects retrospective, current-time, or cross-clause future leakage: %s', async (statement) => {
    const output = analystOutput({
      statement,
      citedFigures: statement.includes('22.4%')
        ? [{ evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' }]
        : [],
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'ROE was 22.4% or less.',
    'ROE was 22.4% or more.',
    'ROE was at most 22.4%.',
    'ROE was at least 22.4%.',
    'ROE was no more than 22.4%.',
    'ROE was no less than 22.4%.',
    'ROE was 22.4%. Or less.',
    'ROE was 22.4%. Or more.',
    'ROE was 22.4%. At most.',
    'ROE was 22.4%. At least.',
    'ROE was 22.4%. No more than that.',
    'ROE was 22.4%. No less than that.',
  ])('rejects exact-observation inequalities, including detached bounds: %s', async (statement) => {
    const output = analystOutput({
      statement,
      citedFigures: [{ evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' }],
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'ROE was 22.4%. Margins expanded.',
    'ROE was 22.4%. It remained above the sector.',
    'ROE was 22.4%. It was approximately zero.',
  ])('rejects a detached quantitative or comparative continuation: %s', async (statement) => {
    const output = analystOutput({
      statement,
      citedFigures: [{ evidenceId: reportId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' }],
    });
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'Sell-side estimates remain contextual.',
    'Buy-side expectations are only background.',
    'Shareholder communication may add context.',
    'Buyback activity remains relevant context.',
    'Holdings data are informative.',
  ])('allows legitimate research terminology: %s', async (summary) => {
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.summary = summary;
    await expect(ground({ output })).resolves.toMatchObject({ summary });
  });

  it.each([
    'Buy BBCA.',
    'Sell BBCA.',
    'Hold BBCA.',
    'Recommend buying BBCA.',
    'Verdict: bullish.',
  ])('rejects recommendation-shaped verdict language: %s', async (summary) => {
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.summary = summary;
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'Buy the stock.',
    'Sell the position.',
    'Hold the shares.',
    'Buy this stock.',
    'Sell this position.',
  ])('rejects an imperative recommendation without a ticker: %s', async (summary) => {
    const output = analystOutput({ statement: 'The report gives relevant context.', citedFigures: [] });
    output.summary = summary;
    await expect(ground({ output })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it.each([
    'The filing led to a disclosure update.',
    'The new report led to additional context.',
  ])('allows causal use of led to without a comparative relation: %s', async (statement) => {
    const output = analystOutput({ statement, citedFigures: [] });
    await expect(ground({ output })).resolves.toMatchObject({ supportingCase: [{ statement }] });
  });

  it.each([
    'ROE led.',
    'The company led peers.',
    'ROE led the sector.',
    'ROE led peers.',
  ])('rejects comparative use of led: %s', async (statement) => {
    await expect(ground({ output: analystOutput({ statement, citedFigures: [] }) }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });

  it('checks synchronous input validity before cancellation, then gives cancellation precedence over malformed output', async () => {
    const controller = new AbortController();
    controller.abort();
    const getManyByIdsForRun = vi.fn(async () => [report()]);
    const evidenceStore = { getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;
    const { groundChallengeOutput } = await import('../src/challenge/grounding.js');

    await expect(groundChallengeOutput({
      executionId: ' ', ticker: 'BBCA', thesis, output: {}, seenEvidenceIds: [reportId], evidenceStore, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(groundChallengeOutput({
      executionId, ticker: 'BBCA', thesis, output: {}, seenEvidenceIds: [reportId], evidenceStore, signal: controller.signal,
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(getManyByIdsForRun).not.toHaveBeenCalled();
  });
});
