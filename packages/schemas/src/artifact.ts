import { z } from 'zod';
import { CitedFigureSchema, ClaimSchema, JudgmentSchema } from './claim.js';
import { BearCounterpointSchema, GroundedCounterpointSchema } from './debate.js';
import { ComparisonMatrixSchema, type ComparisonMatrix } from './comparison.js';

/** Judge release products retain their fixed order for release receipts and profiles. */
export const JUDGE_ARTIFACT_KINDS = ['BULL_CASE', 'BEAR_CASE', 'VERDICT'] as const;
export type JudgeArtifactKind = (typeof JUDGE_ARTIFACT_KINDS)[number];

/** Durable products and the command that owns production for each kind. */
export const ARTIFACT_KINDS = [...JUDGE_ARTIFACT_KINDS, 'RESEARCH_REPORT', 'COMPARISON_REPORT'] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ARTIFACT_PRODUCER_BY_KIND = {
  BULL_CASE: 'judge',
  BEAR_CASE: 'judge',
  VERDICT: 'judge',
  RESEARCH_REPORT: 'research',
  COMPARISON_REPORT: 'compare',
} as const satisfies Record<ArtifactKind, string>;

export const ArtifactRetrievalQuerySchema = z.object({
  sessionId: z.string().min(1),
  subjects: z.string().min(1).array().min(1),
  allowedKinds: ArtifactKindSchema.array().min(1),
  focus: z.enum(['generic', 'downside', 'thesis', 'bull', 'bear']),
  limit: z.number().int().positive().max(20).optional(),
}).strict();
export type ArtifactRetrievalQuery = z.infer<typeof ArtifactRetrievalQuerySchema>;

/** Durable identity; it contains no array position or process-local handle. */
export const ArtifactRefSchema = z.object({
  kind: ArtifactKindSchema,
  artifactId: z.string().min(1),
}).strict();
export type DurableArtifactRef = z.infer<typeof ArtifactRefSchema>;

const BullCaseArgumentSchema = z.object({
  messageId: z.string().min(1),
  reasoning: z.string().min(10),
  claims: ClaimSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
}).strict();

const BearCaseCounterpointSchema = z.union([GroundedCounterpointSchema, BearCounterpointSchema.strict()]);

const BearCaseArgumentSchema = z.object({
  messageId: z.string().min(1),
  reasoning: z.string().min(10),
  counterpoints: BearCaseCounterpointSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
}).strict();

/** One immutable Bull-side artifact containing the initial case and rebuttal. */
export const BullCaseArtifactPayloadSchema = z.object({
  thesis: BullCaseArgumentSchema,
  rebuttal: BullCaseArgumentSchema,
}).strict();
export type BullCaseArtifactPayload = z.infer<typeof BullCaseArtifactPayloadSchema>;

/** One immutable Bear-side challenge against the Bull case. */
export const BearCaseArtifactPayloadSchema = BearCaseArgumentSchema;
export type BearCaseArtifactPayload = z.infer<typeof BearCaseArtifactPayloadSchema>;

/** Final deterministic judgment plus the execution-scoped inputs it evaluated. */
export const VerdictArtifactPayloadSchema = z.object({
  judgment: JudgmentSchema,
  evidenceIds: z.array(z.string().uuid()),
  claimIds: z.array(z.string().min(1)),
  rounds: z.number().int().positive(),
}).strict();
export type VerdictArtifactPayload = z.infer<typeof VerdictArtifactPayloadSchema>;

export const ResearchFindingSchema = z.object({
  statement: z.string().min(1),
  evidenceIds: z.array(z.string().uuid()).min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  citedFigures: z.array(CitedFigureSchema).optional(),
}).strict();
export type ResearchFinding = z.infer<typeof ResearchFindingSchema>;

export const ResearchSourceAssessmentSchema = z.object({
  evidenceId: z.string().uuid(),
  quality: z.enum(['primary', 'secondary', 'weak']),
  rationale: z.string().min(1),
}).strict();
export type ResearchSourceAssessment = z.infer<typeof ResearchSourceAssessmentSchema>;

export const ResearchSourceCoverageSchema = z.discriminatedUnion('status', [
  z.object({ source: z.string().min(1), status: z.literal('available'), evidenceIds: z.array(z.string().uuid()).min(1) }).strict(),
  z.object({ source: z.string().min(1), status: z.literal('unavailable'), reason: z.string().min(1) }).strict(),
  z.object({ source: z.string().min(1), status: z.literal('not_requested') }).strict(),
]);
export type ResearchSourceCoverage = z.infer<typeof ResearchSourceCoverageSchema>;

/** Durable consumer-facing research output; findings are not canonical Claims. */
export const ResearchReportPayloadSchema = z.object({
  question: z.string().min(1),
  summary: z.string().min(1),
  findings: z.array(ResearchFindingSchema),
  sourceAssessments: z.array(ResearchSourceAssessmentSchema),
  gaps: z.array(z.string().min(1)),
  coverage: z.array(ResearchSourceCoverageSchema),
}).strict();
export type ResearchReportPayload = z.infer<typeof ResearchReportPayloadSchema>;

/** The durable comparison contract reuses the canonical normalized matrix without another projection. */
export const ComparisonReportPayloadSchema = ComparisonMatrixSchema;
export type ComparisonReportPayload = ComparisonMatrix;

const EnvelopeBase = {
  artifactId: z.string().min(1),
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  executionId: z.string().min(1),
  ticker: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
} as const;

/** Versioned discriminated envelope persisted by the artifact store. */
const ArtifactEnvelopeUnionSchema = z.discriminatedUnion('kind', [
  z.object({ ...EnvelopeBase, kind: z.literal('BULL_CASE'), payload: BullCaseArtifactPayloadSchema }).strict(),
  z.object({ ...EnvelopeBase, kind: z.literal('BEAR_CASE'), payload: BearCaseArtifactPayloadSchema }).strict(),
  z.object({ ...EnvelopeBase, kind: z.literal('VERDICT'), payload: VerdictArtifactPayloadSchema }).strict(),
  z.object({ ...EnvelopeBase, kind: z.literal('RESEARCH_REPORT'), payload: ResearchReportPayloadSchema }).strict(),
  z.object({ ...EnvelopeBase, kind: z.literal('COMPARISON_REPORT'), payload: ComparisonReportPayloadSchema }).strict(),
]);
export const ArtifactEnvelopeSchema = ArtifactEnvelopeUnionSchema.superRefine((artifact, context) => {
  if (artifact.kind === 'COMPARISON_REPORT' && artifact.ticker !== artifact.payload.subjects[0]?.ticker) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ticker'],
      message: 'Comparison Report ticker must match the first subject',
    });
  }
});
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;
