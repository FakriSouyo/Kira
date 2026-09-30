import { z } from 'zod';

const CanonicalQuarterSchema = z.string().regex(/^\d{4}-Q[1-4]$/).refine(period => Number(period.slice(0, 4)) >= 1);
const TickerSchema = z.string().regex(/^[A-Z]{2,6}$/);

export const ComparisonSubjectSchema = z.object({
  ticker: TickerSchema,
  name: z.string().min(1).optional(),
  sector: z.string().min(1).optional(),
}).strict();
export type ComparisonSubject = z.infer<typeof ComparisonSubjectSchema>;

export const ComparisonSourceReferenceSchema = z.object({
  evidenceId: z.string().uuid(),
  path: z.string().min(1),
  periodLabel: CanonicalQuarterSchema,
}).strict();
export type ComparisonSourceReference = z.infer<typeof ComparisonSourceReferenceSchema>;

const AvailableComparisonCellSchema = z.object({
  ticker: TickerSchema,
  status: z.literal('available'),
  value: z.number().finite(),
  unit: z.literal('percent'),
  source: ComparisonSourceReferenceSchema,
}).strict();

const UnavailableComparisonCellSchema = z.object({
  ticker: TickerSchema,
  status: z.literal('unavailable'),
  reason: z.enum(['BASIS_MISSING', 'BASIS_UNPROVEN', 'VALUE_MISSING']),
  unit: z.literal('percent'),
  source: ComparisonSourceReferenceSchema,
}).strict();

export const ComparisonCellSchema = z.discriminatedUnion('status', [
  AvailableComparisonCellSchema,
  UnavailableComparisonCellSchema,
]);
export type ComparisonCell = z.infer<typeof ComparisonCellSchema>;

const ComparisonMetricNameSchema = z.enum(['revenueGrowthYoy', 'netIncomeGrowthYoy']);

export const ComparisonMetricSchema = z.object({
  metric: ComparisonMetricNameSchema,
  unit: z.literal('percent'),
  status: z.enum(['comparable', 'unavailable']),
  cells: z.array(ComparisonCellSchema).min(2).max(3),
}).strict();
export type ComparisonMetric = z.infer<typeof ComparisonMetricSchema>;

export const ComparisonDifferenceSchema = z.object({
  metric: ComparisonMetricNameSchema,
  leftTicker: TickerSchema,
  rightTicker: TickerSchema,
  value: z.number().finite(),
  unit: z.literal('percentage_points'),
  left: ComparisonSourceReferenceSchema,
  right: ComparisonSourceReferenceSchema,
}).strict();
export type ComparisonDifference = z.infer<typeof ComparisonDifferenceSchema>;

export const ComparisonWarningSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('SELECTED_PERIOD_OLDER_THAN_LATEST'), ticker: TickerSchema, selectedPeriod: CanonicalQuarterSchema, latestAvailablePeriod: CanonicalQuarterSchema }).strict(),
  z.object({ code: z.literal('BASIS_MISSING'), ticker: TickerSchema, metric: ComparisonMetricNameSchema }).strict(),
  z.object({ code: z.literal('BASIS_UNPROVEN'), ticker: TickerSchema, metric: ComparisonMetricNameSchema }).strict(),
  z.object({ code: z.literal('MISSING_SECTOR'), ticker: TickerSchema }).strict(),
  z.object({ code: z.literal('MIXED_SECTORS'), tickers: z.array(TickerSchema).min(2).max(3) }).strict(),
  z.object({ code: z.literal('COMPANY_REPORT_FRESHNESS_UNKNOWN'), ticker: TickerSchema }).strict(),
  z.object({ code: z.literal('COMPANY_REPORT_TIMESTAMP_MISMATCH'), tickers: z.array(TickerSchema).min(1).max(3) }).strict(),
]);
export type ComparisonWarning = z.infer<typeof ComparisonWarningSchema>;

const ComparisonMatrixShape = z.object({
  subjects: z.array(ComparisonSubjectSchema).min(2).max(3),
  selectedPeriod: CanonicalQuarterSchema,
  metrics: z.array(ComparisonMetricSchema).length(2),
  differences: z.array(ComparisonDifferenceSchema),
  warnings: z.array(ComparisonWarningSchema),
}).strict();

/** Strict deterministic matrix contract; cross-field proof is checked at parse time. */
export const ComparisonMatrixSchema = ComparisonMatrixShape.superRefine((matrix, context) => {
  const tickers = matrix.subjects.map(subject => subject.ticker);
  if (new Set(tickers).size !== tickers.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['subjects'], message: 'Comparison subjects must be unique' });
  }

  const expectedMetrics = ['revenueGrowthYoy', 'netIncomeGrowthYoy'];
  for (let metricIndex = 0; metricIndex < expectedMetrics.length; metricIndex += 1) {
    const metric = matrix.metrics[metricIndex];
    if (!metric) continue;
    if (metric.metric !== expectedMetrics[metricIndex]) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics', metricIndex, 'metric'], message: 'Comparison metrics must use the fixed order' });
    }
    if (metric.cells.length !== tickers.length || metric.cells.some((cell, index) => cell.ticker !== tickers[index])) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics', metricIndex, 'cells'], message: 'Comparison cells must follow subject order' });
    }
    const allAvailable = metric.cells.length === tickers.length && metric.cells.every(cell => cell.status === 'available');
    if ((metric.status === 'comparable') !== allAvailable) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics', metricIndex, 'status'], message: 'Metric comparability must match full subject coverage' });
    }
    metric.cells.forEach((cell, cellIndex) => {
      if (cell.source.periodLabel !== matrix.selectedPeriod) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics', metricIndex, 'cells', cellIndex, 'source', 'periodLabel'], message: 'Cell source must use the selected period' });
      }
    });
  }

  if (!matrix.metrics.some(metric => metric.status === 'comparable')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['metrics'], message: 'At least one metric must cover every subject' });
  }

  const expectedDifferences: Array<{ metric: string; leftTicker: string; rightTicker: string; left: ComparisonSourceReference; right: ComparisonSourceReference; value: number }> = [];
  for (const metric of matrix.metrics) {
    if (metric.status !== 'comparable') continue;
    for (let leftIndex = 0; leftIndex < tickers.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < tickers.length; rightIndex += 1) {
        const leftCell = metric.cells[leftIndex];
        const rightCell = metric.cells[rightIndex];
        if (leftCell?.status === 'available' && rightCell?.status === 'available') {
          expectedDifferences.push({
            metric: metric.metric,
            leftTicker: tickers[leftIndex]!,
            rightTicker: tickers[rightIndex]!,
            left: leftCell.source,
            right: rightCell.source,
            value: leftCell.value - rightCell.value,
          });
        }
      }
    }
  }
  if (matrix.differences.length !== expectedDifferences.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['differences'], message: 'Pairwise differences must cover every comparable metric and subject pair' });
  }
  for (let index = 0; index < Math.min(matrix.differences.length, expectedDifferences.length); index += 1) {
    const actual = matrix.differences[index]!;
    const expected = expectedDifferences[index]!;
    if (actual.metric !== expected.metric || actual.leftTicker !== expected.leftTicker || actual.rightTicker !== expected.rightTicker
      || actual.value !== expected.value || JSON.stringify(actual.left) !== JSON.stringify(expected.left)
      || JSON.stringify(actual.right) !== JSON.stringify(expected.right)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['differences', index], message: 'Pairwise difference does not match its operand cells' });
    }
  }

  for (const [index, warning] of matrix.warnings.entries()) {
    const warningTickers = 'ticker' in warning ? [warning.ticker] : 'tickers' in warning ? warning.tickers : [];
    if (warningTickers.some(ticker => !tickers.includes(ticker))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['warnings', index], message: 'Warning subject must belong to the comparison' });
    }
  }
});
export type ComparisonMatrix = z.infer<typeof ComparisonMatrixSchema>;
