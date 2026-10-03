import { describe, expect, it, vi } from 'vitest';
import { UserFriendlyError, ValidationError } from '@harness/shared';
import type { EvidenceStore } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import { groundResearcherOutput } from '../src/research/grounding.js';
import type { ResearcherOutput } from '@harness/subagent-researcher';

const executionId = 'execution-research-1';
const seenId = '11111111-1111-4111-8111-111111111111';
const unseenId = '22222222-2222-4222-8222-222222222222';
const foreignId = '33333333-3333-4333-8333-333333333333';

function acceptedFinancialEvidence(params: {
  id: string;
  runId?: string;
  source: string;
  observationKind: 'company_report' | 'quarterly_financials';
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}): Evidence {
  const provenance = {
    metadata: params.metadata,
    verification: { schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: 'PASS' },
    observationKind: params.observationKind,
  };
  return {
    id: params.id,
    runId: params.runId ?? executionId,
    ticker: 'BBCA',
    source: params.source,
    sourceType: 'mock',
    contentHash: 'a'.repeat(64),
    retrievedAt: '2026-09-25T00:00:00.000Z',
    data: params.data,
    provenance,
    acceptance: {
      policyId: 'evidence-policy-v1',
      policyFingerprint: 'b'.repeat(64),
      candidateKind: 'financial',
      sourceOrigin: 'MOCK',
      retrievedAt: null,
      acceptedAt: '2026-09-25T00:00:00.000Z',
      validAt: null,
      provenance: { ...provenance },
    },
  };
}

function companyReportEvidence(
  id: string,
  runId = executionId,
  options: { metadataDataAsOf?: string | null; dataAsOf?: string | null; includeMetadataDataAsOf?: boolean } = {},
): Evidence {
  const metadataDataAsOf = options.metadataDataAsOf === undefined ? '2024-12-31' : options.metadataDataAsOf;
  const dataAsOf = options.dataAsOf === undefined ? '2024-12-31' : options.dataAsOf;
  return acceptedFinancialEvidence({
    id,
    runId,
    source: 'sectors.company_report',
    observationKind: 'company_report',
    data: {
      ticker: 'BBCA',
      ...(dataAsOf ? { asOf: dataAsOf } : {}),
      financials: { roe: 22.4 },
      valuation: { pe: 12 },
    },
    metadata: {
      providerId: 'sectors',
      source: 'sectors.company_report',
      origin: 'MOCK',
      fetchedAt: null,
      ...(options.includeMetadataDataAsOf === false ? {} : { dataAsOf: metadataDataAsOf }),
      requestedAsOf: null,
      period: null,
      derivedFrom: [],
    },
  });
}

function quarterlyEvidence(id: string, runId = executionId): Evidence {
  return acceptedFinancialEvidence({
    id,
    runId,
    source: 'sectors.quarterly_financials',
    observationKind: 'quarterly_financials',
    data: {
      ticker: 'BBCA',
      currency: 'IDR',
      quarters: [
        { period: '2025-Q4', revenue: 100, netIncome: 20, revenueGrowthYoy: 22.4, netIncomeGrowthYoy: 11.2 },
        { period: '2025-Q3', revenue: 95, netIncome: 19, revenueGrowthYoy: 20.4, netIncomeGrowthYoy: 10.2 },
      ],
      cumulativeYtd: { periodLabel: '2025 FY vs 2024 FY', revenueGrowthYoy: 22.4, netIncomeGrowthYoy: 11.2 },
    },
    metadata: {
      providerId: 'sectors',
      source: 'sectors.quarterly_financials',
      origin: 'MOCK',
      fetchedAt: null,
      dataAsOf: null,
      requestedAsOf: null,
      period: '2025-Q4',
      derivedFrom: [],
    },
  });
}

const evidence = (id: string, runId = executionId): Evidence => companyReportEvidence(id, runId);

const numericOutput = (): ResearcherOutput => ({
  summary: 'The Company Report reference data is as of 2024-12-31.',
  findings: [{
    claim: 'ROE was 22.4%.',
    evidenceIds: [seenId],
    confidence: 'high',
    citedFigures: [{ evidenceId: seenId, path: 'financials.roe', value: 22.4, periodLabel: '2024-12-31' }],
  }],
  sourceAssessments: [{ evidenceId: seenId, quality: 'primary', rationale: 'Issuer filing.' }],
  gaps: ['No quarterly detail was supplied.'],
});

function createEvidenceStore(items: Evidence[] = [evidence(seenId)]) {
  const getManyByIdsForRun = vi.fn(async (runId: string, ids: string[]) =>
    items.filter(item => item.runId === runId && ids.includes(item.id)));
  return { getManyByIdsForRun } as Pick<EvidenceStore, 'getManyByIdsForRun'> & {
    getManyByIdsForRun: typeof getManyByIdsForRun;
  };
}

function ground(
  output = numericOutput(),
  options: {
    executionId?: string;
    seenEvidenceIds?: readonly string[];
    evidenceStore?: Pick<EvidenceStore, 'getManyByIdsForRun'>;
  } = {},
) {
  return groundResearcherOutput({
    executionId: options.executionId ?? executionId,
    output,
    seenEvidenceIds: options.seenEvidenceIds ?? [seenId],
    evidenceStore: options.evidenceStore ?? createEvidenceStore(),
  });
}

describe('groundResearcherOutput', () => {
  it.each(['summary', 'finding', 'source assessment rationale', 'gap'])(
    'rejects transaction advice in Kira-authored %s prose', async (field) => {
      const output = numericOutput();
      const directive = 'I recommend selling BBCA.';
      if (field === 'summary') output.summary = directive;
      else if (field === 'finding') output.findings[0]!.claim = directive;
      else if (field === 'source assessment rationale') output.sourceAssessments[0]!.rationale = directive;
      else output.gaps[0] = directive;
      const store = createEvidenceStore();

      await expect(ground(output, { evidenceStore: store })).rejects.toThrow(/transaction/i);
      expect(store.getManyByIdsForRun).not.toHaveBeenCalled();
    },
  );

  it('grounds a Company Report figure to its exact reference date', async () => {
    const store = createEvidenceStore();
    const result = await ground(numericOutput(), { evidenceStore: store });

    expect(result).toEqual({
      summary: 'The Company Report reference data is as of 2024-12-31.',
      findings: [{
        statement: 'ROE was 22.4%.',
        evidenceIds: [seenId],
        confidence: 'high',
        citedFigures: [{ evidenceId: seenId, path: 'financials.roe', value: 22.4, periodLabel: '2024-12-31' }],
      }],
      sourceAssessments: [{ evidenceId: seenId, quality: 'primary', rationale: 'Issuer filing.' }],
      gaps: ['No quarterly detail was supplied.'],
    });
    expect(store.getManyByIdsForRun).toHaveBeenCalledWith(executionId, [seenId]);
  });

  it.each([
    'Revenue growth was 22.4%.',
    'ROA was 22.4%.',
    'P/E was 22.4x.',
    'Revenue was IDR 22.4 billion.',
  ])('rejects a current financial assertion for another metric: %s', async statement => {
    const output = numericOutput();
    output.findings[0]!.claim = statement;
    await expect(ground(output)).rejects.toThrow(/metric|financial|statement/i);
  });

  it('rejects a current financial assertion with the wrong unit', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'ROE was 22.4x.';
    await expect(ground(output)).rejects.toThrow(/unit|metric|financial|statement/i);
  });

  it.each(['ROE was twenty-two point four percent.', 'ROE was twenty.'])('rejects unsupported Research number words: %s', async statement => {
    const output = numericOutput();
    output.findings[0]!.claim = statement;
    await expect(ground(output)).rejects.toThrow(/metric|financial|statement/i);
  });

  it('accepts and rejects quarterly currency assertions according to the Evidence currency', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'Revenue was IDR 100.';
    output.findings[0]!.evidenceIds = [unseenId];
    output.findings[0]!.citedFigures = [{ evidenceId: unseenId, path: 'quarters[0].revenue', value: 100, periodLabel: '2025-Q4' }];
    output.sourceAssessments[0]!.evidenceId = unseenId;
    const quarterly = quarterlyEvidence(unseenId);
    await expect(ground(output, { seenEvidenceIds: [unseenId], evidenceStore: createEvidenceStore([quarterly]) })).resolves.toBeDefined();

    output.findings[0]!.claim = 'Revenue was USD 100.';
    await expect(ground(output, { seenEvidenceIds: [unseenId], evidenceStore: createEvidenceStore([quarterly]) })).rejects.toThrow(/currency|unit|financial|statement/i);

    output.findings[0]!.claim = 'Revenue was IDR 100 billion.';
    await expect(ground(output, { seenEvidenceIds: [unseenId], evidenceStore: createEvidenceStore([quarterly]) })).rejects.toThrow(/currency|unit|financial|statement/i);

    output.findings[0]!.claim = 'Two sources report revenue of IDR 100.';
    await expect(ground(output, { seenEvidenceIds: [unseenId], evidenceStore: createEvidenceStore([quarterly]) })).resolves.toBeDefined();
  });

  it('accepts the current metric, value, and unit for P/E', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'P/E was 12x.';
    output.findings[0]!.citedFigures = [{ evidenceId: seenId, path: 'valuation.pe', value: 12, periodLabel: '2024-12-31' }];
    await expect(ground(output)).resolves.toMatchObject({ findings: [{ statement: 'P/E was 12x.' }] });
  });

  it('rejects invalid Researcher output through the producer schema', async () => {
    await expect(ground({ summary: '', findings: [], sourceAssessments: [], gaps: [] } as unknown as ResearcherOutput))
      .rejects.toThrow();
  });

  it('rejects an empty Execution identity', async () => {
    await expect(ground(numericOutput(), { executionId: '' })).rejects.toThrow(ValidationError);
  });

  it('rejects duplicate finding Evidence IDs', async () => {
    const output = numericOutput();
    output.findings[0]!.evidenceIds = [seenId, seenId];
    await expect(ground(output)).rejects.toThrow(/duplicate/i);
  });

  it('rejects Evidence that was in the Execution but was not seen by Researcher', async () => {
    const output = numericOutput();
    output.findings[0]!.evidenceIds = [unseenId];
    output.findings[0]!.citedFigures![0]!.evidenceId = unseenId;
    output.sourceAssessments[0]!.evidenceId = unseenId;
    await expect(ground(output, {
      seenEvidenceIds: [seenId],
      evidenceStore: createEvidenceStore([evidence(unseenId)]),
    })).rejects.toThrow(/seen|supplied/i);
  });

  it('rejects Evidence that belongs to a different Execution', async () => {
    const output = numericOutput();
    output.findings[0]!.evidenceIds = [foreignId];
    output.findings[0]!.citedFigures![0]!.evidenceId = foreignId;
    output.sourceAssessments[0]!.evidenceId = foreignId;
    await expect(ground(output, {
      seenEvidenceIds: [foreignId],
      evidenceStore: createEvidenceStore([evidence(foreignId, 'execution-other')]),
    })).rejects.toThrow(/execution|membership/i);
  });

  it('requires an assessment for each finding Evidence ID', async () => {
    const output = numericOutput();
    output.sourceAssessments = [];
    await expect(ground(output)).rejects.toThrow(/assessment/i);
  });

  it('rejects duplicate source assessments', async () => {
    const output = numericOutput();
    output.sourceAssessments.push({ ...output.sourceAssessments[0]! });
    await expect(ground(output)).rejects.toThrow(/duplicate/i);
  });

  it('rejects unseen source assessments', async () => {
    const output = numericOutput();
    output.sourceAssessments.push({ evidenceId: unseenId, quality: 'secondary', rationale: 'Related article.' });
    await expect(ground(output, { evidenceStore: createEvidenceStore([evidence(seenId), evidence(unseenId)]) }))
      .rejects.toThrow(/seen|supplied/i);
  });

  it('rejects a CitedFigure that is not linked to its finding', async () => {
    const output = numericOutput();
    output.findings[0]!.citedFigures![0]!.evidenceId = unseenId;
    await expect(ground(output, {
      seenEvidenceIds: [seenId, unseenId],
      evidenceStore: createEvidenceStore([evidence(seenId), evidence(unseenId)]),
    })).rejects.toThrow(/linked|finding/i);
  });

  it('rejects a missing Evidence path', async () => {
    const output = numericOutput();
    output.findings[0]!.citedFigures![0]!.path = 'financials.missing';
    await expect(ground(output)).rejects.toThrow(/path/i);
  });

  it('rejects a CitedFigure value that differs from Evidence', async () => {
    const output = numericOutput();
    output.findings[0]!.citedFigures![0]!.value = 23.4;
    await expect(ground(output)).rejects.toThrow(/mismatch|value/i);
  });

  it('rejects a Company Report label that differs from its reference date', async () => {
    const output = numericOutput();
    output.findings[0]!.citedFigures![0]!.periodLabel = '2024-12-30';
    await expect(ground(output)).rejects.toThrow(/period|temporal/i);
  });

  it('rejects a Company Report without any authoritative temporal anchor', async () => {
    await expect(ground(numericOutput(), {
      evidenceStore: createEvidenceStore([companyReportEvidence(seenId, executionId, {
        metadataDataAsOf: null,
        dataAsOf: null,
      })]),
    })).rejects.toThrow(/period|temporal/i);
  });

  it('uses Company Report data.asOf when metadata.dataAsOf is absent', async () => {
    const output = numericOutput();
    await expect(ground(output, {
      evidenceStore: createEvidenceStore([companyReportEvidence(seenId, executionId, { includeMetadataDataAsOf: false })]),
    })).resolves.toMatchObject({
      findings: [{ citedFigures: [{ periodLabel: '2024-12-31' }] }],
    });
  });

  it('uses accepted provenance metadata.dataAsOf when primary metadata is unavailable', async () => {
    const companyReport = companyReportEvidence(seenId, executionId, { metadataDataAsOf: null, dataAsOf: null });
    companyReport.acceptance!.provenance.metadata = {
      ...(companyReport.acceptance!.provenance.metadata as Record<string, unknown>),
      dataAsOf: '2024-12-31',
    };
    await expect(ground(numericOutput(), { evidenceStore: createEvidenceStore([companyReport]) })).resolves.toMatchObject({
      findings: [{ citedFigures: [{ periodLabel: '2024-12-31' }] }],
    });
  });

  it('rejects conflicting Company Report metadata and data reference dates', async () => {
    await expect(ground(numericOutput(), {
      evidenceStore: createEvidenceStore([companyReportEvidence(seenId, executionId, { metadataDataAsOf: '2025-01-01' })]),
    })).rejects.toThrow(/conflict|temporal|period/i);
  });

  it('rejects conflicting canonical observation kinds in accepted Evidence provenance', async () => {
    const conflicting = companyReportEvidence(seenId);
    conflicting.acceptance!.provenance.observationKind = 'quarterly_financials';
    await expect(ground(numericOutput(), { evidenceStore: createEvidenceStore([conflicting]) }))
      .rejects.toThrow(/observation|kind|provenance/i);
  });

  it('does not infer Company Report kind from the source string when provenance kind is unsupported', async () => {
    const unsupported = companyReportEvidence(seenId);
    unsupported.provenance!.observationKind = 'news';
    unsupported.acceptance!.provenance.observationKind = 'news';
    await expect(ground(numericOutput(), { evidenceStore: createEvidenceStore([unsupported]) }))
      .rejects.toThrow(/observation|kind|provenance/i);
  });

  it('grounds quarterly quarters[0] figures to the exact row period', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'Revenue growth was 22.4%.';
    output.findings[0]!.citedFigures![0]!.path = 'quarters[0].revenueGrowthYoy';
    output.findings[0]!.citedFigures![0]!.periodLabel = '2025-Q4';

    await expect(ground(output, { evidenceStore: createEvidenceStore([quarterlyEvidence(seenId)]) })).resolves.toMatchObject({
      findings: [{ citedFigures: [{ periodLabel: '2025-Q4' }] }],
    });
  });

  it('rejects a quarterly quarters[0] label that differs from the row period', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'Revenue growth was 22.4%.';
    output.findings[0]!.citedFigures![0]!.path = 'quarters[0].revenueGrowthYoy';
    output.findings[0]!.citedFigures![0]!.periodLabel = '2025-Q3';
    await expect(ground(output, { evidenceStore: createEvidenceStore([quarterlyEvidence(seenId)]) }))
      .rejects.toThrow(/period|temporal/i);
  });

  it('uses a historical quarterly row period instead of the latest metadata period', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'Revenue growth was 20.4%.';
    output.findings[0]!.citedFigures![0]!.path = 'quarters.1.revenueGrowthYoy';
    output.findings[0]!.citedFigures![0]!.value = 20.4;
    output.findings[0]!.citedFigures![0]!.periodLabel = '2025-Q3';
    await expect(ground(output, { evidenceStore: createEvidenceStore([quarterlyEvidence(seenId)]) })).resolves.toMatchObject({
      findings: [{ citedFigures: [{ periodLabel: '2025-Q3' }] }],
    });
  });

  it('grounds quarterly cumulativeYtd figures to cumulativeYtd.periodLabel', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'Revenue growth was 22.4% year over year.';
    output.findings[0]!.citedFigures![0]!.path = 'cumulativeYtd.revenueGrowthYoy';
    output.findings[0]!.citedFigures![0]!.periodLabel = '2025 FY vs 2024 FY';
    await expect(ground(output, { evidenceStore: createEvidenceStore([quarterlyEvidence(seenId)]) })).resolves.toMatchObject({
      findings: [{ citedFigures: [{ periodLabel: '2025 FY vs 2024 FY' }] }],
    });
  });

  it('rejects a numeric assertion with no matching grounded CitedFigure', async () => {
    const output = numericOutput();
    output.findings[0]!.citedFigures = undefined;
    await expect(ground(output)).rejects.toThrow(/numeric|figure/i);
  });

  it('accepts a prose finding without a recognized numeric assertion', async () => {
    const output = numericOutput();
    output.findings[0]!.claim = 'The issuer filing provides a useful profitability baseline.';
    output.findings[0]!.citedFigures = undefined;
    await expect(ground(output)).resolves.toMatchObject({ findings: [{ statement: output.findings[0]!.claim }] });
  });

  it('surfaces Evidence membership read failure as validation unavailable', async () => {
    const failure = new Error('Evidence persistence is unavailable');
    const evidenceStore = {
      getManyByIdsForRun: vi.fn().mockRejectedValue(failure),
    } as unknown as Pick<EvidenceStore, 'getManyByIdsForRun'>;

    await expect(ground(numericOutput(), { evidenceStore })).rejects.toMatchObject({
      code: 'VALIDATION_UNAVAILABLE',
      name: 'UserFriendlyError',
    } satisfies Partial<UserFriendlyError>);
  });
});
