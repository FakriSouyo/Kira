import { z } from 'zod';

export const ChallengeMetricSchema = z.enum([
  'roe',
  'roa',
  'netMargin',
  'grossMargin',
  'debtToEquity',
  'currentRatio',
  'revenueGrowthYoy',
  'netIncomeGrowthYoy',
  'price',
  'pe',
  'pb',
  'dividendYield',
  'revenue',
  'netIncome',
]);
export type ChallengeMetric = z.infer<typeof ChallengeMetricSchema>;

export const ChallengeUnitClassSchema = z.enum(['percent', 'ratio', 'multiple', 'nominal', 'currency']);
export type ChallengeUnitClass = z.infer<typeof ChallengeUnitClassSchema>;

/** Source fields are supplied by the analyst; Engine validates and enriches them. */
export const ChallengeCitedFigureInputSchema = z.object({
  evidenceId: z.string().uuid(),
  path: z.string().min(1),
  value: z.number().finite(),
  periodLabel: z.string().min(1),
}).strict();
export type ChallengeCitedFigureInput = z.infer<typeof ChallengeCitedFigureInputSchema>;

/** Canonical financial interpretation is attached by Engine after verification. */
export const ChallengeCitedFigureSchema = ChallengeCitedFigureInputSchema.extend({
  metric: ChallengeMetricSchema,
  unitClass: ChallengeUnitClassSchema,
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict();
export type ChallengeCitedFigure = z.infer<typeof ChallengeCitedFigureSchema>;

export const ChallengeFindingSchema = z.object({
  statement: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1).refine(ids => new Set(ids).size === ids.length, {
    message: 'Challenge finding Evidence IDs must be unique',
  }),
  confidence: z.enum(['high', 'medium', 'low']),
  citedFigures: z.array(ChallengeCitedFigureSchema).optional(),
}).strict();
export type ChallengeFinding = z.infer<typeof ChallengeFindingSchema>;

export const ChallengeSourceAssessmentSchema = z.object({
  evidenceId: z.string().uuid(),
  quality: z.enum(['primary', 'secondary', 'weak']),
  rationale: z.string().min(1),
}).strict();
export type ChallengeSourceAssessment = z.infer<typeof ChallengeSourceAssessmentSchema>;

export const ChallengeSourceCoverageSchema = z.object({
  source: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1).refine(ids => new Set(ids).size === ids.length, {
    message: 'Challenge source coverage Evidence IDs must be unique',
  }),
}).strict();
export type ChallengeSourceCoverage = z.infer<typeof ChallengeSourceCoverageSchema>;

const ChallengeReportShape = z.object({
  thesis: z.string().min(1),
  summary: z.string().min(1),
  supportingCase: z.array(ChallengeFindingSchema),
  counterCase: z.array(ChallengeFindingSchema),
  unsupportedAssumptions: z.array(z.string().min(1)),
  failureConditions: z.array(z.string().min(1)),
  evidenceThatWouldChangeThesis: z.array(z.string().min(1)),
  sourceAssessments: z.array(ChallengeSourceAssessmentSchema),
  gaps: z.array(z.string().min(1)),
  coverage: z.array(ChallengeSourceCoverageSchema).min(1),
}).strict();

/** Strict, non-verdict contract for an execution-grounded thesis challenge. */
export const ChallengeReportPayloadSchema = ChallengeReportShape.superRefine((report, context) => {
  if (report.supportingCase.length + report.counterCase.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['supportingCase'],
      message: 'Challenge report requires at least one supporting or counter finding',
    });
  }
  const sources = report.coverage.map(entry => entry.source);
  if (new Set(sources).size !== sources.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['coverage'],
      message: 'Challenge coverage sources must be unique',
    });
  }
});
export type ChallengeReportPayload = z.infer<typeof ChallengeReportPayloadSchema>;
