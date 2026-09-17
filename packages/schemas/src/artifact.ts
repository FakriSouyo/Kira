import { z } from 'zod';
import { ClaimSchema, JudgmentSchema } from './claim.js';

/** Artifact kinds currently produced by the canonical `/judge` workflow. */
export const ARTIFACT_KINDS = ['BULL_CASE', 'BEAR_CASE', 'VERDICT'] as const;
export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

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

const BearCaseArgumentSchema = z.object({
  messageId: z.string().min(1),
  reasoning: z.string().min(10),
  counterpoints: z.array(z.object({
    targetClaimId: z.string().min(1),
    argument: z.string().min(5),
    strength: z.enum(['high', 'moderate', 'low']),
  }).strict()).min(1),
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
export const ArtifactEnvelopeSchema = z.discriminatedUnion('kind', [
  z.object({ ...EnvelopeBase, kind: z.literal('BULL_CASE'), payload: BullCaseArtifactPayloadSchema }).strict(),
  z.object({ ...EnvelopeBase, kind: z.literal('BEAR_CASE'), payload: BearCaseArtifactPayloadSchema }).strict(),
  z.object({ ...EnvelopeBase, kind: z.literal('VERDICT'), payload: VerdictArtifactPayloadSchema }).strict(),
]);
export type ArtifactEnvelope = z.infer<typeof ArtifactEnvelopeSchema>;
