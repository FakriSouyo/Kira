import { describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_POLICY_FINGERPRINT,
  EVIDENCE_POLICY_ID,
  type EvidenceStore,
} from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import { ComparisonMatrixSchema } from '@harness/schemas';
import {
  ComparisonNormalizationError,
  normalizeComparisonEvidence,
} from '../src/index.js';

const executionId = 'execution-compare-1';
const ids = {
  BBCA: { report: '11111111-1111-4111-8111-111111111111', quarterly: '22222222-2222-4222-8222-222222222222' },
  BBRI: { report: '33333333-3333-4333-8333-333333333333', quarterly: '44444444-4444-4444-8444-444444444444' },
  BMRI: { report: '55555555-5555-4555-8555-555555555555', quarterly: '66666666-6666-4666-8666-666666666666' },
} as const;

type Ticker = keyof typeof ids;
type GrowthBasis = Record<string, unknown>;

interface MutableComparisonCell {
  status: string;
  value?: number;
  reason?: string;
  source?: { evidenceId: string; path: string; periodLabel: string };
  [key: string]: unknown;
}

interface MutableComparisonMetric {
  status: string;
  unit: string;
  cells: MutableComparisonCell[];
  [key: string]: unknown;
}

interface MutableComparisonMatrix {
  selectedPeriod: string;
  metrics: MutableComparisonMetric[];
  differences: Array<{ value: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function provenBasis(period: string): Record<string, unknown> {
  const match = /^(\d{4})-Q([1-4])$/.exec(period)!;
  return {
    status: 'proven',
    method: 'same_quarter_prior_year',
    period,
    comparisonPeriod: `${Number(match[1]) - 1}-Q${match[2]}`,
    periodType: 'single_quarter',
    unit: 'percent',
  };
}

function quarter(
  period: string,
  revenueGrowthYoy: number | undefined,
  netIncomeGrowthYoy: number | undefined,
  options: {
    periodType?: string | null;
    growthBasis?: { revenueGrowthYoy?: GrowthBasis; netIncomeGrowthYoy?: GrowthBasis } | null;
    revenue?: number;
    netIncome?: number;
  } = {},
) {
  return {
    period,
    ...(options.periodType === null ? {} : { periodType: options.periodType ?? 'single_quarter' }),
    revenue: options.revenue ?? 100,
    netIncome: options.netIncome ?? 10,
    ...(revenueGrowthYoy === undefined ? {} : { revenueGrowthYoy }),
    ...(netIncomeGrowthYoy === undefined ? {} : { netIncomeGrowthYoy }),
    ...(options.growthBasis === null ? {} : {
      growthBasis: options.growthBasis ?? {
        revenueGrowthYoy: provenBasis(period),
        netIncomeGrowthYoy: provenBasis(period),
      },
    }),
  };
}

function evidence(params: {
  id: string;
  ticker: Ticker;
  kind: 'company_report' | 'quarterly_financials';
  runId?: string;
  data?: Record<string, unknown>;
}): Evidence {
  const source = `sectors.${params.kind}`;
  const metadata = {
    providerId: 'sectors', source, origin: 'MOCK', fetchedAt: null,
    dataAsOf: null, requestedAsOf: null,
    period: params.kind === 'quarterly_financials' ? '2025-Q4' : null,
    derivedFrom: [],
  };
  // requestedAsOf is null, so verifyFinancialObservation reports temporal PASS.
  const verification = { schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: 'PASS' };
  const observationKind = params.kind;
  const provenance = { metadata, verification, observationKind };
  const data = params.data ?? (params.kind === 'company_report'
    ? { ticker: params.ticker, name: `${params.ticker} name`, sector: 'Banking', financials: {}, valuation: {} }
    : { ticker: params.ticker, quarters: [quarter('2025-Q4', 10, 5)] });
  return {
    id: params.id,
    runId: params.runId ?? executionId,
    ticker: params.ticker,
    source,
    sourceType: 'mock',
    contentHash: 'a'.repeat(64),
    retrievedAt: '2026-09-25T00:00:00.000Z',
    data,
    provenance,
    acceptance: {
      policyId: EVIDENCE_POLICY_ID,
      policyFingerprint: EVIDENCE_POLICY_FINGERPRINT,
      candidateKind: 'financial',
      sourceOrigin: 'MOCK',
      retrievedAt: null,
      acceptedAt: '2026-09-25T00:00:00.000Z',
      validAt: null,
      provenance,
    },
  };
}

function subjectEvidence(ticker: Ticker, quarters: unknown[], reportData?: Record<string, unknown>): Evidence[] {
  return [
    evidence({
      id: ids[ticker].report,
      ticker,
      kind: 'company_report',
      ...(reportData ? { data: reportData } : {}),
    }),
    evidence({
      id: ids[ticker].quarterly,
      ticker,
      kind: 'quarterly_financials',
      data: { ticker, quarters },
    }),
  ];
}

function withCompanyReportDates(item: Evidence, params: {
  asOf: string | null;
  metadataDataAsOf: string | null;
  fetchedAt?: string | null;
}): Evidence {
  const reportData = { ...item.data };
  if (params.asOf === null) delete reportData.asOf;
  else reportData.asOf = params.asOf;
  const currentProvenance = (item.provenance ?? {}) as Record<string, unknown>;
  const acceptedProvenance = item.acceptance!.provenance;
  const metadata = {
    ...((currentProvenance.metadata ?? {}) as Record<string, unknown>),
    dataAsOf: params.metadataDataAsOf,
    ...(params.fetchedAt === undefined ? {} : { fetchedAt: params.fetchedAt }),
  };
  return {
    ...item,
    data: reportData,
    provenance: { ...currentProvenance, metadata },
    acceptance: {
      ...item.acceptance!,
      ...(params.fetchedAt === undefined ? {} : { retrievedAt: params.fetchedAt }),
      provenance: { ...acceptedProvenance, metadata },
    },
  };
}

function sourcesFor(tickers: readonly Ticker[]) {
  return tickers.map(ticker => ({
    ticker,
    companyReportEvidenceId: ids[ticker].report,
    quarterlyFinancialsEvidenceId: ids[ticker].quarterly,
  }));
}

function storeFor(items: Evidence[]) {
  const getManyByIdsForRun = vi.fn(async (runId: string, requestedIds: string[]) =>
    items.filter(item => item.runId === runId && requestedIds.includes(item.id)));
  return { getManyByIdsForRun } as Pick<EvidenceStore, 'getManyByIdsForRun'> & {
    getManyByIdsForRun: typeof getManyByIdsForRun;
  };
}

function normalize(
  tickers: readonly Ticker[],
  items: Evidence[],
  evidenceStore: Pick<EvidenceStore, 'getManyByIdsForRun'> = storeFor(items),
) {
  return normalizeComparisonEvidence({
    executionId,
    subjects: [...tickers],
    sources: sourcesFor(tickers),
    evidenceStore,
  });
}

function normalizeRaw(params: {
  executionId?: string;
  subjects: readonly string[];
  sources: Array<{ ticker: string; companyReportEvidenceId: string; quarterlyFinancialsEvidenceId: string }>;
  evidenceStore: Pick<EvidenceStore, 'getManyByIdsForRun'>;
  signal?: AbortSignal;
}) {
  return normalizeComparisonEvidence({
    ...params,
    executionId: params.executionId ?? executionId,
  });
}

describe('normalizeComparisonEvidence', () => {
  it('selects the latest common quarter and keeps paths anchored to the original Evidence array indexes', async () => {
    const bbca = subjectEvidence('BBCA', [
      quarter('2025-Q3', 8, -4),
      quarter('2025-Q4', 11.4, 0),
      quarter('2026-Q1', 14, 2),
    ]);
    const bbri = subjectEvidence('BBRI', [
      quarter('2025-Q4', 8.9, -2),
      quarter('2025-Q3', 7, -5),
    ]);
    const result = await normalize(['BBCA', 'BBRI'], [...bbca, ...bbri]);

    expect(result.subjects.map(subject => subject.ticker)).toEqual(['BBCA', 'BBRI']);
    expect(result.selectedPeriod).toBe('2025-Q4');
    expect(result.metrics).toMatchObject([
      {
        metric: 'revenueGrowthYoy', unit: 'percent', status: 'comparable',
        cells: [
          { ticker: 'BBCA', status: 'available', value: 11.4, source: { evidenceId: ids.BBCA.quarterly, path: 'quarters[1].revenueGrowthYoy', periodLabel: '2025-Q4' } },
          { ticker: 'BBRI', status: 'available', value: 8.9, source: { evidenceId: ids.BBRI.quarterly, path: 'quarters[0].revenueGrowthYoy', periodLabel: '2025-Q4' } },
        ],
      },
      {
        metric: 'netIncomeGrowthYoy', unit: 'percent', status: 'comparable',
        cells: [
          { ticker: 'BBCA', status: 'available', value: 0 },
          { ticker: 'BBRI', status: 'available', value: -2 },
        ],
      },
    ]);
    expect(result.differences).toEqual([
      expect.objectContaining({
        metric: 'revenueGrowthYoy', leftTicker: 'BBCA', rightTicker: 'BBRI',
        value: 2.5, unit: 'percentage_points',
        left: { evidenceId: ids.BBCA.quarterly, path: 'quarters[1].revenueGrowthYoy', periodLabel: '2025-Q4' },
        right: { evidenceId: ids.BBRI.quarterly, path: 'quarters[0].revenueGrowthYoy', periodLabel: '2025-Q4' },
      }),
      expect.objectContaining({
        metric: 'netIncomeGrowthYoy', leftTicker: 'BBCA', rightTicker: 'BBRI',
        value: 2, unit: 'percentage_points',
      }),
    ]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'SELECTED_PERIOD_OLDER_THAN_LATEST',
      ticker: 'BBCA',
      selectedPeriod: '2025-Q4',
      latestAvailablePeriod: '2026-Q1',
    }));
    expect(ComparisonMatrixSchema.parse(result)).toEqual(result);
  });

  it('trims and uppercases subjects while preserving normalized source mapping order', async () => {
    const tickers = ['BBCA', 'BBRI'] as const;
    const rows = [
      ...subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]),
      ...subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]),
    ];
    const evidenceStore = storeFor(rows);
    const result = await normalizeRaw({
      executionId,
      subjects: [' bbca ', 'bbri  '],
      sources: [
        { ticker: 'bbca', companyReportEvidenceId: ids.BBCA.report, quarterlyFinancialsEvidenceId: ids.BBCA.quarterly },
        { ticker: ' BBRI ', companyReportEvidenceId: ids.BBRI.report, quarterlyFinancialsEvidenceId: ids.BBRI.quarterly },
      ],
      evidenceStore,
    });

    expect(result.subjects.map(subject => subject.ticker)).toEqual(tickers);
    expect(evidenceStore.getManyByIdsForRun).toHaveBeenCalledWith(executionId, [
      ids.BBCA.report, ids.BBCA.quarterly, ids.BBRI.report, ids.BBRI.quarterly,
    ]);
  });

  it('keeps an unproven Company Report growth value unavailable instead of treating it as comparable', async () => {
    const unproven = { status: 'unproven', reason: 'COMPANY_REPORT_PERIOD_UNVERIFIED' };
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, {
      growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3, {
      growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const result = await normalize(['BBCA', 'BBRI'], [...bbca, ...bbri]);

    expect(result.metrics[0]).toMatchObject({
      metric: 'revenueGrowthYoy', status: 'unavailable',
      cells: [
        { ticker: 'BBCA', status: 'unavailable', reason: 'BASIS_UNPROVEN' },
        { ticker: 'BBRI', status: 'unavailable', reason: 'BASIS_UNPROVEN' },
      ],
    });
    expect(result.metrics[1]).toMatchObject({ metric: 'netIncomeGrowthYoy', status: 'comparable' });
    expect(result.differences.map(row => row.metric)).toEqual(['netIncomeGrowthYoy']);
    expect(result.metrics[0]?.cells.map(cell => cell.ticker)).toEqual(['BBCA', 'BBRI']);
  });

  it('keeps missing growth basis unavailable and never computes a delta for only the available subject', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, {
      growthBasis: { netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3, {
      growthBasis: { revenueGrowthYoy: provenBasis('2025-Q4'), netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const result = await normalize(['BBCA', 'BBRI'], [...bbca, ...bbri]);

    expect(result.metrics[0]).toMatchObject({
      metric: 'revenueGrowthYoy', status: 'unavailable',
      cells: [
        { ticker: 'BBCA', status: 'unavailable', reason: 'BASIS_MISSING' },
        { ticker: 'BBRI', status: 'available', value: 8 },
      ],
    });
    expect(result.differences.map(row => row.metric)).not.toContain('revenueGrowthYoy');
  });

  it('labels an absent numeric growth value unavailable while retaining the missing-basis warning', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', undefined, 5, {
      growthBasis: { netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const result = await normalize(['BBCA', 'BBRI'], [...bbca, ...bbri]);

    expect(result.metrics[0]).toMatchObject({ metric: 'revenueGrowthYoy', status: 'unavailable' });
    expect(result.metrics[0]?.cells[0]).toMatchObject({
      ticker: 'BBCA', status: 'unavailable', reason: 'VALUE_MISSING',
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'BASIS_MISSING', ticker: 'BBCA', metric: 'revenueGrowthYoy',
    }));
    expect(result.metrics[1]).toMatchObject({ metric: 'netIncomeGrowthYoy', status: 'comparable' });
  });

  it('emits explicit BASIS_UNPROVEN and BASIS_MISSING warning records', async () => {
    const unproven = { status: 'unproven', reason: 'COMPANY_REPORT_PERIOD_UNVERIFIED' };
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, {
      growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3, {
      growthBasis: { netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const result = await normalize(['BBCA', 'BBRI'], [...bbca, ...bbri]);

    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'BASIS_UNPROVEN', ticker: 'BBCA', metric: 'revenueGrowthYoy',
    }));
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'BASIS_MISSING', ticker: 'BBRI', metric: 'revenueGrowthYoy',
    }));
  });

  it('warns when sectors are missing or disagree across the requested subjects', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)], {
      ticker: 'BBCA', name: 'BBCA name', financials: {}, valuation: {},
    });
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)], {
      ticker: 'BBRI', name: 'BBRI name', sector: 'Banking', financials: {}, valuation: {},
    });
    const bmri = subjectEvidence('BMRI', [quarter('2025-Q4', 7, -4)], {
      ticker: 'BMRI', name: 'BMRI name', sector: 'Industrials', financials: {}, valuation: {},
    });
    const result = await normalize(['BBCA', 'BBRI', 'BMRI'], [...bbca, ...bbri, ...bmri]);

    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'MISSING_SECTOR', ticker: 'BBCA' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'MIXED_SECTORS' }));
  });

  it('warns when Company Report asOf/metadata dates are unknown or disagree across companies', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const unknownDates = [
      withCompanyReportDates(bbca[0]!, { asOf: null, metadataDataAsOf: null }), bbca[1]!,
      withCompanyReportDates(bbri[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01' }), bbri[1]!,
    ];
    const unknownResult = await normalize(['BBCA', 'BBRI'], unknownDates);
    expect(unknownResult.warnings).toContainEqual(expect.objectContaining({
      code: 'COMPANY_REPORT_FRESHNESS_UNKNOWN', ticker: 'BBCA',
    }));

    const differentCompanyDates = [
      withCompanyReportDates(bbca[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01' }), bbca[1]!,
      withCompanyReportDates(bbri[0]!, { asOf: '2025-02-01', metadataDataAsOf: '2025-02-01' }), bbri[1]!,
    ];
    const mismatchResult = await normalize(['BBCA', 'BBRI'], differentCompanyDates);
    expect(mismatchResult.warnings).toContainEqual(expect.objectContaining({
      code: 'COMPANY_REPORT_TIMESTAMP_MISMATCH', tickers: ['BBCA', 'BBRI'],
    }));
  });

  it('warns specifically for unknown or mismatched Company Report acquisition timestamps', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const reportsWithKnownEffectiveDate = [
      withCompanyReportDates(bbca[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01', fetchedAt: null }), bbca[1]!,
      withCompanyReportDates(bbri[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01', fetchedAt: null }), bbri[1]!,
    ];
    const unknownAcquisition = await normalize(['BBCA', 'BBRI'], reportsWithKnownEffectiveDate);
    expect(unknownAcquisition.warnings).toContainEqual(expect.objectContaining({
      code: 'COMPANY_REPORT_FRESHNESS_UNKNOWN', ticker: 'BBCA',
    }));

    const differentAcquisitionTimes = [
      withCompanyReportDates(bbca[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01', fetchedAt: '2025-01-02T00:00:00.000Z' }), bbca[1]!,
      withCompanyReportDates(bbri[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01', fetchedAt: '2025-01-03T00:00:00.000Z' }), bbri[1]!,
    ];
    const mismatchedAcquisition = await normalize(['BBCA', 'BBRI'], differentAcquisitionTimes);
    expect(mismatchedAcquisition.warnings).toContainEqual(expect.objectContaining({
      code: 'COMPANY_REPORT_TIMESTAMP_MISMATCH', tickers: ['BBCA', 'BBRI'],
    }));
  });

  it('treats impossible Company Report dates and acquisition instants as unknown', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const rows = [
      withCompanyReportDates(bbca[0]!, {
        asOf: '2025-02-31', metadataDataAsOf: '2025-02-31', fetchedAt: '2025-02-31T00:00:00.000Z',
      }), bbca[1]!,
      withCompanyReportDates(bbri[0]!, {
        asOf: '2025-03-03', metadataDataAsOf: '2025-03-03', fetchedAt: '2025-03-03T00:00:00.000Z',
      }), bbri[1]!,
    ];

    const result = await normalize(['BBCA', 'BBRI'], rows);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'COMPANY_REPORT_FRESHNESS_UNKNOWN', ticker: 'BBCA',
    }));
  });

  it.each(['2025-01-02', '2025-01-02T00:00:00.000'])('does not infer a timezone or time for fetchedAt %s', async fetchedAt => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const rows = [
      withCompanyReportDates(bbca[0]!, { asOf: '2025-01-01', metadataDataAsOf: '2025-01-01', fetchedAt }), bbca[1]!,
      withCompanyReportDates(bbri[0]!, {
        asOf: '2025-01-01', metadataDataAsOf: '2025-01-01', fetchedAt: '2025-01-02T00:00:00.000Z',
      }), bbri[1]!,
    ];

    const result = await normalize(['BBCA', 'BBRI'], rows);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'COMPANY_REPORT_FRESHNESS_UNKNOWN', ticker: 'BBCA',
    }));
  });

  it.each([
    { metric: 'revenueGrowthYoy', value: Number.NaN },
    { metric: 'revenueGrowthYoy', value: Number.POSITIVE_INFINITY },
    { metric: 'netIncomeGrowthYoy', value: Number.NEGATIVE_INFINITY },
  ])('rejects nonfinite $metric value $value when a basis is present', async ({ metric, value }) => {
    const invalidQuarter = { ...quarter('2025-Q4', 10, 5), [metric]: value };
    const rows = [
      ...subjectEvidence('BBCA', [invalidQuarter]),
      ...subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]),
    ];

    await expect(normalize(['BBCA', 'BBRI'], rows)).rejects.toThrow();
  });

  it('does not compare when a present basis names the wrong quarter', async () => {
    const wrongPeriod = { ...provenBasis('2025-Q3'), period: '2025-Q3' };
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, {
      growthBasis: { revenueGrowthYoy: wrongPeriod, netIncomeGrowthYoy: provenBasis('2025-Q4') },
    })]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);

    await expect(normalize(['BBCA', 'BBRI'], [...bbca, ...bbri])).rejects.toBeInstanceOf(ComparisonNormalizationError);
  });

  it('fails closed when neither fixed growth metric is comparable for every subject', async () => {
    const unproven = { status: 'unproven', reason: 'COMPANY_REPORT_PERIOD_UNVERIFIED' };
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, {
      growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: unproven },
    })]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3, {
      growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: unproven },
    })]);

    await expect(normalize(['BBCA', 'BBRI'], [...bbca, ...bbri])).rejects.toMatchObject({ code: 'NO_COMPARABLE_METRICS' });
  });

  it('fails without a common eligible single-quarter period and does not infer missing periodType', async () => {
    const noCommon = [
      ...subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]),
      ...subjectEvidence('BBRI', [quarter('2025-Q3', 8, -3)]),
    ];
    await expect(normalize(['BBCA', 'BBRI'], noCommon)).rejects.toMatchObject({ code: 'NO_COMMON_COMPARABLE_PERIOD' });

    const missingType = [
      ...subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, { periodType: null })]),
      ...subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]),
    ];
    await expect(normalize(['BBCA', 'BBRI'], missingType)).rejects.toMatchObject({ code: 'NO_COMMON_COMPARABLE_PERIOD' });
  });

  it.each(['2025-YTD', '2025-FY', 'Q4 2025', 'not-a-period'])('rejects noncanonical or cumulative period %s', async period => {
    const invalid = [
      ...subjectEvidence('BBCA', [quarter(period, 10, 5, { growthBasis: null })]),
      ...subjectEvidence('BBRI', [quarter(period, 8, -3, { growthBasis: null })]),
    ];
    await expect(normalize(['BBCA', 'BBRI'], invalid)).rejects.toThrow();
  });

  it('rejects duplicate canonical quarter labels rather than selecting an overwritten row', async () => {
    const duplicate = [
      ...subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5), quarter('2025-Q4', 11, 6)]),
      ...subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]),
    ];
    await expect(normalize(['BBCA', 'BBRI'], duplicate)).rejects.toThrow();
  });

  it('requires one scoped Evidence lookup and rejects records outside the supplied Execution membership', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const rows = [...bbca, ...bbri];
    const getManyByIds = vi.fn(async () => rows);
    const evidenceStore = {
      getManyByIds,
      getManyByIdsForRun: vi.fn(async (runId: string, requestedIds: string[]) =>
        rows.filter(item => item.runId === runId && requestedIds.includes(item.id))),
    } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;

    await normalize(['BBCA', 'BBRI'], rows, evidenceStore);

    expect(evidenceStore.getManyByIdsForRun).toHaveBeenCalledTimes(1);
    expect(evidenceStore.getManyByIdsForRun).toHaveBeenCalledWith(executionId, [
      ids.BBCA.report, ids.BBCA.quarterly, ids.BBRI.report, ids.BBRI.quarterly,
    ]);
    expect(getManyByIds).not.toHaveBeenCalled();

    const foreignRows = rows.map(item => item.id === ids.BBRI.quarterly ? { ...item, runId: 'execution-other' } : item);
    await expect(normalize(['BBCA', 'BBRI'], foreignRows)).rejects.toThrow();
  });

  it('rejects missing, extra, duplicate, foreign, misattributed or unaccepted scoped records', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const rows = [...bbca, ...bbri];
    const extra = evidence({ id: '77777777-7777-4777-8777-777777777777', ticker: 'BBCA', kind: 'company_report' });
    const wrongRun = rows.map(item => item.id === ids.BBRI.quarterly ? { ...item, runId: 'execution-other' } : item);
    const wrongTicker = rows.map(item => item.id === ids.BBCA.quarterly ? { ...item, ticker: 'BBRI' } : item);
    const wrongKind = structuredClone(rows);
    wrongKind[0]!.provenance = { ...wrongKind[0]!.provenance, observationKind: 'quarterly_financials' };
    wrongKind[0]!.acceptance!.provenance = { ...wrongKind[0]!.acceptance!.provenance, observationKind: 'quarterly_financials' };
    const legacy = structuredClone(rows);
    legacy[0]!.acceptance!.candidateKind = 'legacy';
    legacy[0]!.acceptance!.legacy = true;
    const corruptPolicy = structuredClone(rows);
    corruptPolicy[0]!.acceptance!.policyId = 'evidence-policy-v999';
    const corruptFingerprint = structuredClone(rows);
    corruptFingerprint[0]!.acceptance!.policyFingerprint = 'c'.repeat(64);
    const missingAcceptedAt = structuredClone(rows);
    missingAcceptedAt[0]!.acceptance!.acceptedAt = null;
    const malformedAcceptedAt = structuredClone(rows);
    malformedAcceptedAt[0]!.acceptance!.acceptedAt = 'not-a-timestamp';
    const nonNullValidAt = structuredClone(rows);
    nonNullValidAt[0]!.acceptance!.validAt = '2025-12-31T00:00:00.000Z';
    nonNullValidAt[0]!.validAt = '2025-12-31T00:00:00.000Z';
    const conflictingProvenance = structuredClone(rows);
    conflictingProvenance[0]!.acceptance!.provenance = {
      ...conflictingProvenance[0]!.acceptance!.provenance,
      observationKind: 'quarterly_financials',
    };
    const verifierRejected = structuredClone(rows);
    verifierRejected[1]!.data.ticker = 'BMRI';

    const responses: Array<{ name: string; rows: Evidence[] }> = [
      { name: 'missing requested ID', rows: rows.slice(1) },
      { name: 'extra unrequested ID', rows: [...rows, extra] },
      { name: 'foreign ID from another run', rows: [...rows, { ...extra, runId: 'execution-other' }] },
      { name: 'duplicate returned ID', rows: [...rows, rows[0]!] },
      { name: 'foreign run view', rows: wrongRun },
      { name: 'wrong Evidence ticker', rows: wrongTicker },
      { name: 'wrong observation kind', rows: wrongKind },
      { name: 'legacy acceptance', rows: legacy },
      { name: 'corrupt acceptance policy', rows: corruptPolicy },
      { name: 'acceptance fingerprint mismatch', rows: corruptFingerprint },
      { name: 'missing acceptance timestamp', rows: missingAcceptedAt },
      { name: 'malformed acceptance timestamp', rows: malformedAcceptedAt },
      { name: 'non-null validity under current policy', rows: nonNullValidAt },
      { name: 'conflicting duplicate provenance', rows: conflictingProvenance },
      { name: 'financial verifier mismatch', rows: verifierRejected },
    ];

    for (const response of responses) {
      const scopedStore = {
        getManyByIdsForRun: vi.fn(async () => response.rows),
      } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;
      await expect(normalize(['BBCA', 'BBRI'], rows, scopedStore), response.name).rejects.toThrow();
      expect(scopedStore.getManyByIdsForRun, response.name).toHaveBeenCalledTimes(1);
    }

    const swappedSources: Array<{
      ticker: string;
      companyReportEvidenceId: string;
      quarterlyFinancialsEvidenceId: string;
    }> = sourcesFor(['BBCA', 'BBRI']);
    swappedSources[0] = {
      ...swappedSources[0]!,
      companyReportEvidenceId: ids.BBCA.quarterly,
      quarterlyFinancialsEvidenceId: ids.BBCA.report,
    };
    await expect(normalizeRaw({
      executionId,
      subjects: ['BBCA', 'BBRI'],
      sources: swappedSources,
      evidenceStore: storeFor(rows),
    })).rejects.toThrow();
  });

  it('preserves subjects and emits every ordered pair for three companies', async () => {
    const tickers = ['BBCA', 'BBRI', 'BMRI'] as const;
    const rows = tickers.flatMap((ticker, index) => subjectEvidence(ticker, [quarter('2025-Q4', 10 - index, 5 - index)]));
    const result = await normalize(tickers, rows);

    expect(result.subjects.map(subject => subject.ticker)).toEqual(tickers);
    expect(result.differences.filter(row => row.metric === 'revenueGrowthYoy').map(row => [row.leftTicker, row.rightTicker]))
      .toEqual([['BBCA', 'BBRI'], ['BBCA', 'BMRI'], ['BBRI', 'BMRI']]);
  });

  it('keeps normalized inputs immutable and output identical across repeated runs and wall-clock changes', async () => {
    const rows = [
      ...subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5), quarter('2025-Q3', 8, -4)]),
      ...subjectEvidence('BBRI', [quarter('2025-Q3', 7, -5), quarter('2025-Q4', 8, -3)]),
    ];
    const originalRows = structuredClone(rows);
    const subjects = deepFreeze(['BBCA', 'BBRI'] as const);
    const sources = deepFreeze(sourcesFor(subjects));
    const frozenRows = deepFreeze(rows);
    const evidenceStore = storeFor(frozenRows);
    const params = { executionId, subjects, sources, evidenceStore };
    const first = await normalizeComparisonEvidence(params);

    vi.useFakeTimers();
    let second;
    try {
      vi.setSystemTime(new Date('2044-01-01T00:00:00.000Z'));
      second = await normalizeComparisonEvidence(params);
    } finally {
      vi.useRealTimers();
    }

    expect(second).toEqual(first);
    expect(frozenRows).toEqual(originalRows);
    expect(subjects).toEqual(['BBCA', 'BBRI']);
    expect(sources).toEqual(sourcesFor(['BBCA', 'BBRI']));
  });

  it('validates Comparison Matrix strictly and rejects malformed values, references, units, periods and unavailable cells', async () => {
    const unproven = { status: 'unproven', reason: 'COMPANY_REPORT_PERIOD_UNVERIFIED' };
    const rows = [
      ...subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5, {
        growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: provenBasis('2025-Q4') },
      })]),
      ...subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3, {
        growthBasis: { revenueGrowthYoy: unproven, netIncomeGrowthYoy: provenBasis('2025-Q4') },
      })]),
    ];
    const result = await normalize(['BBCA', 'BBRI'], rows);

    expect(ComparisonMatrixSchema.parse(result)).toEqual(result);
    expect(() => ComparisonMatrixSchema.parse({ ...result, unexpected: true })).toThrow();

    const extraMetricField = structuredClone(result) as unknown as MutableComparisonMatrix;
    extraMetricField.metrics[0]!.unexpected = true;
    expect(() => ComparisonMatrixSchema.parse(extraMetricField)).toThrow();

    const nonfinite = structuredClone(result) as unknown as MutableComparisonMatrix;
    nonfinite.metrics[1]!.cells[0]!.value = Number.POSITIVE_INFINITY;
    expect(() => ComparisonMatrixSchema.parse(nonfinite)).toThrow();

    const malformedReference = structuredClone(result) as unknown as MutableComparisonMatrix;
    malformedReference.metrics[1]!.cells[0]!.source!.evidenceId = 'not-a-uuid';
    expect(() => ComparisonMatrixSchema.parse(malformedReference)).toThrow();

    const invalidUnit = structuredClone(result) as unknown as MutableComparisonMatrix;
    invalidUnit.metrics[0]!.unit = 'IDR';
    expect(() => ComparisonMatrixSchema.parse(invalidUnit)).toThrow();

    const invalidPeriod = structuredClone(result) as unknown as MutableComparisonMatrix;
    invalidPeriod.selectedPeriod = '2025-FY';
    expect(() => ComparisonMatrixSchema.parse(invalidPeriod)).toThrow();

    const malformedUnavailable = structuredClone(result) as unknown as MutableComparisonMatrix;
    delete malformedUnavailable.metrics[0]!.cells[0]!.reason;
    expect(() => ComparisonMatrixSchema.parse(malformedUnavailable)).toThrow();

    const missingUnavailableSource = structuredClone(result) as unknown as MutableComparisonMatrix;
    delete missingUnavailableSource.metrics[0]!.cells[0]!.source;
    expect(() => ComparisonMatrixSchema.parse(missingUnavailableSource)).toThrow();

    const falseComparableStatus = structuredClone(result) as unknown as MutableComparisonMatrix;
    falseComparableStatus.metrics[0]!.status = 'comparable';
    expect(() => ComparisonMatrixSchema.parse(falseComparableStatus)).toThrow();

    const alteredDifference = structuredClone(result) as unknown as MutableComparisonMatrix;
    alteredDifference.differences[0]!.value += 1;
    expect(() => ComparisonMatrixSchema.parse(alteredDifference)).toThrow();

    const wrongUnavailablePeriod = structuredClone(result) as unknown as MutableComparisonMatrix;
    wrongUnavailablePeriod.metrics[0]!.cells[0]!.source!.periodLabel = '2025-Q3';
    expect(() => ComparisonMatrixSchema.parse(wrongUnavailablePeriod)).toThrow();
  });

  it('validates execution, subject count/tickers, mappings and IDs before any Evidence lookup', async () => {
    const getManyByIdsForRun = vi.fn(async () => []);
    const evidenceStore = { getManyByIdsForRun } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;

    const valid = sourcesFor(['BBCA', 'BBRI']);
    const cases = [
      { executionId: '   ', subjects: ['BBCA', 'BBRI'], sources: valid },
      { executionId, subjects: ['BBCA'], sources: sourcesFor(['BBCA']) },
      { executionId, subjects: ['BBCA', 'BBRI', 'BMRI', 'BBNI'], sources: valid },
      { executionId, subjects: ['BBCA', 'A1'], sources: valid },
      { executionId, subjects: ['BBCA', ' bbca '], sources: [valid[0]!, { ...valid[1]!, ticker: 'bbca' }] },
      { executionId, subjects: ['BBCA', 'BBRI'], sources: [valid[0]!] },
      { executionId, subjects: ['BBCA', 'BBRI'], sources: [...valid, { ...sourcesFor(['BMRI'])[0]! }] },
      { executionId, subjects: ['BBCA', 'BBRI'], sources: [valid[0]!, { ...valid[1]!, ticker: 'BBCA' }] },
      { executionId, subjects: ['BBCA', 'BBRI'], sources: [valid[0]!, { ...valid[1]!, quarterlyFinancialsEvidenceId: 'not-a-uuid' }] },
      { executionId, subjects: ['BBCA', 'BBRI'], sources: [valid[0]!, { ...valid[1]!, companyReportEvidenceId: ids.BBCA.report }] },
      { executionId, subjects: ['BBCA', 'BBRI'], sources: [valid[0]!, { ...valid[1]!, quarterlyFinancialsEvidenceId: ids.BBCA.quarterly }] },
    ];

    for (const item of cases) {
      await expect(normalizeRaw({ ...item, evidenceStore })).rejects.toThrow();
    }
    expect(getManyByIdsForRun).not.toHaveBeenCalled();
  });

  it('wraps scoped-store failure with its cause and treats cancellation as cancellation', async () => {
    const bbca = subjectEvidence('BBCA', [quarter('2025-Q4', 10, 5)]);
    const bbri = subjectEvidence('BBRI', [quarter('2025-Q4', 8, -3)]);
    const failure = new Error('sqlite is unavailable');
    const evidenceStore = { getManyByIdsForRun: vi.fn().mockRejectedValue(failure) } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;

    await expect(normalize(['BBCA', 'BBRI'], [...bbca, ...bbri], evidenceStore))
      .rejects.toMatchObject({ code: 'VALIDATION_UNAVAILABLE', cause: failure });

    const controller = new AbortController();
    controller.abort();
    const store = storeFor([...bbca, ...bbri]);
    await expect(normalizeComparisonEvidence({
      executionId, subjects: ['BBCA', 'BBRI'], sources: sourcesFor(['BBCA', 'BBRI']),
      evidenceStore: store, signal: controller.signal,
    })).rejects.toThrow();
    expect(store.getManyByIdsForRun).not.toHaveBeenCalled();

    const controllerDuringRead = new AbortController();
    let signalStoreEntered!: () => void;
    let releaseStore!: () => void;
    const entered = new Promise<void>(resolve => { signalStoreEntered = resolve; });
    const blockedRead = new Promise<void>(resolve => { releaseStore = resolve; });
    const duringReadStore = {
      getManyByIdsForRun: vi.fn(async () => {
        signalStoreEntered();
        await blockedRead;
        return [...bbca, ...bbri];
      }),
    } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;
    const normalization = normalizeComparisonEvidence({
      executionId, subjects: ['BBCA', 'BBRI'], sources: sourcesFor(['BBCA', 'BBRI']),
      evidenceStore: duringReadStore, signal: controllerDuringRead.signal,
    });
    await entered;
    controllerDuringRead.abort();
    releaseStore();
    await expect(normalization).rejects.toThrow();
    expect(duringReadStore.getManyByIdsForRun).toHaveBeenCalledTimes(1);
  });
});
