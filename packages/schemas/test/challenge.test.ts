import { describe, expect, it } from 'vitest';
import {
  ChallengeReportPayloadSchema,
  type ChallengeReportPayload,
} from '@harness/schemas';

const evidenceId = '11111111-1111-4111-8111-111111111111';

function payload(): ChallengeReportPayload {
  return {
    thesis: 'BBCA can sustain its current profitability.',
    summary: 'The supplied evidence supports profitability but leaves execution risks.',
    supportingCase: [{
      statement: 'ROE is 22.4%.',
      evidenceIds: [evidenceId],
      confidence: 'high',
      citedFigures: [{
        evidenceId,
        path: 'financials.roe',
        value: 22.4,
        periodLabel: '2025-12-31',
        metric: 'roe',
        unitClass: 'percent',
      }],
    }],
    counterCase: [],
    unsupportedAssumptions: ['Margins remain resilient.'],
    failureConditions: ['Several periods of weaker profitability would undermine the thesis.'],
    evidenceThatWouldChangeThesis: ['A later report showing persistent margin pressure.'],
    sourceAssessments: [{ evidenceId, quality: 'primary', rationale: 'The report is issuer-sourced.' }],
    gaps: ['No management guidance was supplied.'],
    coverage: [{ source: 'sectors.company_report', evidenceIds: [evidenceId] }],
  };
}

describe('ChallengeReportPayloadSchema', () => {
  it('accepts a strict challenge synthesis with either case empty', () => {
    expect(ChallengeReportPayloadSchema.parse(payload())).toEqual(payload());
  });

  it('accepts the counter-case when the supporting case is empty', () => {
    const value = payload();
    value.supportingCase = [];
    value.counterCase = [{
      statement: 'Current ratio is 0.8.',
      evidenceIds: [evidenceId],
      confidence: 'medium',
      citedFigures: [{
        evidenceId,
        path: 'financials.currentRatio',
        value: 0.8,
        periodLabel: '2025-12-31',
        metric: 'currentRatio',
        unitClass: 'ratio',
      }],
    }];
    expect(ChallengeReportPayloadSchema.parse(value)).toEqual(value);
  });

  it('requires at least one finding across both cases', () => {
    const value = payload();
    value.supportingCase = [];
    value.counterCase = [];
    expect(ChallengeReportPayloadSchema.safeParse(value).success).toBe(false);
  });

  it('requires unique, nonempty finding Evidence IDs', () => {
    const value = payload();
    value.supportingCase[0]!.evidenceIds = [evidenceId, evidenceId];
    expect(ChallengeReportPayloadSchema.safeParse(value).success).toBe(false);
  });

  it.each(['verdict', 'score', 'winner', 'stance', 'ranking', 'target', 'recommendation'])(
    'rejects the prohibited %s field',
    (field) => {
      const value = { ...payload(), [field]: 'bullish' };
      expect(ChallengeReportPayloadSchema.safeParse(value).success).toBe(false);
    },
  );

  it('only permits finite cited values and the fixed metric and unit enums', () => {
    const nonFinite = payload();
    nonFinite.supportingCase[0]!.citedFigures![0]!.value = Number.POSITIVE_INFINITY;
    expect(ChallengeReportPayloadSchema.safeParse(nonFinite).success).toBe(false);

    const unsupportedMetric = payload() as unknown as Record<string, unknown>;
    const supportingCase = unsupportedMetric.supportingCase as Array<Record<string, unknown>>;
    const citedFigures = supportingCase[0]!.citedFigures as Array<Record<string, unknown>>;
    citedFigures[0]!.metric = 'ranking';
    expect(ChallengeReportPayloadSchema.safeParse(unsupportedMetric).success).toBe(false);
  });

  it('permits only an uppercase three-letter optional currency code', () => {
    const value = payload();
    value.supportingCase[0]!.citedFigures![0]!.currencyCode = 'IDR';
    expect(ChallengeReportPayloadSchema.safeParse(value).success).toBe(true);
    value.supportingCase[0]!.citedFigures![0]!.currencyCode = 'idr';
    expect(ChallengeReportPayloadSchema.safeParse(value).success).toBe(false);
  });
});
