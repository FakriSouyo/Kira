import { describe, expect, it } from 'vitest';
import { ComparisonMatrixSchema, ComparisonReportPayloadSchema, type ComparisonMatrix } from '@harness/schemas';
import { buildComparisonReportPayload } from '../src/index.js';

function matrix(): ComparisonMatrix {
  return ComparisonMatrixSchema.parse({
    subjects: [{ ticker: 'BBCA', sector: 'Banking' }, { ticker: 'BBRI', sector: 'Banking' }],
    selectedPeriod: '2025-Q4',
    metrics: [
      {
        metric: 'revenueGrowthYoy', unit: 'percent', status: 'comparable',
        cells: [
          { ticker: 'BBCA', status: 'available', value: 10, unit: 'percent', source: { evidenceId: '11111111-1111-4111-8111-111111111111', path: 'quarters[0].revenueGrowthYoy', periodLabel: '2025-Q4' } },
          { ticker: 'BBRI', status: 'available', value: 8, unit: 'percent', source: { evidenceId: '22222222-2222-4222-8222-222222222222', path: 'quarters[0].revenueGrowthYoy', periodLabel: '2025-Q4' } },
        ],
      },
      {
        metric: 'netIncomeGrowthYoy', unit: 'percent', status: 'unavailable',
        cells: [
          { ticker: 'BBCA', status: 'unavailable', reason: 'BASIS_UNPROVEN', unit: 'percent', source: { evidenceId: '11111111-1111-4111-8111-111111111111', path: 'quarters[0].netIncomeGrowthYoy', periodLabel: '2025-Q4' } },
          { ticker: 'BBRI', status: 'unavailable', reason: 'BASIS_UNPROVEN', unit: 'percent', source: { evidenceId: '22222222-2222-4222-8222-222222222222', path: 'quarters[0].netIncomeGrowthYoy', periodLabel: '2025-Q4' } },
        ],
      },
    ],
    differences: [{
      metric: 'revenueGrowthYoy', leftTicker: 'BBCA', rightTicker: 'BBRI', value: 2,
      unit: 'percentage_points',
      left: { evidenceId: '11111111-1111-4111-8111-111111111111', path: 'quarters[0].revenueGrowthYoy', periodLabel: '2025-Q4' },
      right: { evidenceId: '22222222-2222-4222-8222-222222222222', path: 'quarters[0].revenueGrowthYoy', periodLabel: '2025-Q4' },
    }],
    warnings: [],
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

describe('comparison report payload builder', () => {
  it('returns the exact deterministic schema-v1 payload without mutating the matrix', () => {
    const input = deepFreeze(matrix());
    const result = buildComparisonReportPayload(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(ComparisonReportPayloadSchema.parse(result)).toEqual(result);
  });

  it('rejects additional or malformed report fields through the strict payload schema', () => {
    expect(() => buildComparisonReportPayload({ ...matrix(), narrative: 'not part of v1' } as never)).toThrow();
    const malformed = matrix() as ComparisonMatrix & { ranking?: unknown };
    malformed.ranking = ['BBCA'];
    expect(() => buildComparisonReportPayload(malformed)).toThrow();
  });
});
