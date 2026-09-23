import { z } from 'zod';
import { ClaimProposalSchema, ClaimSchema } from './claim.js';
import { BreakdownSchema } from './claim.js';

export const BullLLMOutputSchema = z.object({
  reasoning: z.string().min(10),
  claims: ClaimSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
});

export type BullLLMOutput = z.infer<typeof BullLLMOutputSchema>;

/** Historical output above remains the checkpoint reader; this is the current model contract. */
export const BullProposalOutputSchema = BullLLMOutputSchema.extend({ claims: ClaimProposalSchema.array().min(1) }).strict();
export type BullProposalOutput = z.infer<typeof BullProposalOutputSchema>;

export const BearCounterpointSchema = z.object({
  targetClaimId: z.string().min(1),
  argument: z.string().min(5),
  strength: z.enum(['high', 'moderate', 'low']),
});

export type BearCounterpoint = z.infer<typeof BearCounterpointSchema>;

/** Strict historical shape used when distinguishing old Counterpoints from current T3 data. */
export const HistoricalBearCounterpointSchema = BearCounterpointSchema.strict();

/** Explicit Evidence relationship asserted by the Bear producer, not inferred as semantic truth. */
export const CounterpointEvidenceLinkSchema = z.object({
  evidenceId: z.string().uuid(),
  relation: z.enum(['supports', 'contradicts', 'qualifies']),
  rationale: z.string().min(1),
}).strict();
export type CounterpointEvidenceLink = z.infer<typeof CounterpointEvidenceLinkSchema>;

/** Current model-write contract; code-owned identity and policy fields are intentionally absent. */
export const BearCounterpointProposalSchema = z.object({
  targetClaimId: z.string().min(1),
  argument: z.string().min(5),
  strength: z.enum(['high', 'moderate', 'low']),
  evidenceIds: z.array(z.string().uuid()).min(1),
  evidenceLinks: CounterpointEvidenceLinkSchema.array().min(1),
  citedFigures: z.array(z.object({
    evidenceId: z.string().uuid(),
    path: z.string().min(1),
    value: z.number(),
    periodLabel: z.string().min(1),
  }).strict()).optional(),
}).strict();
export type BearCounterpointProposal = z.infer<typeof BearCounterpointProposalSchema>;

/** Canonical current Counterpoint. Historical BearCounterpointSchema above remains unchanged. */
export const GroundedCounterpointSchema = BearCounterpointProposalSchema.extend({
  counterpointId: z.string().min(1),
  sourceNodeId: z.enum(['round-1-bear-challenge', 'conditional-bear-rechallenge']),
  policyId: z.string().min(1),
  policyFingerprint: z.string().min(1),
}).strict();
export type GroundedCounterpoint = z.infer<typeof GroundedCounterpointSchema>;

/** Accepts current grounded context while keeping old checkpoint Counterpoints readable. */
export const BearCounterpointContextSchema = z.union([GroundedCounterpointSchema, HistoricalBearCounterpointSchema]);
export type BearCounterpointContext = z.infer<typeof BearCounterpointContextSchema>;

export const BearLLMOutputSchema = z.object({
  reasoning: z.string().min(10),
  counterpoints: BearCounterpointSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
});

export type BearLLMOutput = z.infer<typeof BearLLMOutputSchema>;

/** Current Bear model contract. The historical schema above remains the checkpoint reader. */
export const BearProposalOutputSchema = BearLLMOutputSchema
  .extend({ counterpoints: BearCounterpointProposalSchema.array().min(1) })
  .strict();
export type BearProposalOutput = z.infer<typeof BearProposalOutputSchema>;

/** Current checkpoint response includes a workflow-owned message identity. */
export const BearProposalResponseSchema = BearProposalOutputSchema.extend({ messageId: z.string().min(1) }).strict();
export type BearProposalResponse = z.infer<typeof BearProposalResponseSchema>;

/** Raw Judge model output; score and stance are recomputed outside the model. */
export const JudgeLLMOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  stance: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.enum(['high', 'moderate', 'low']),
  breakdown: BreakdownSchema,
  summary: z.string(),
});

export type JudgeLLMOutput = z.infer<typeof JudgeLLMOutputSchema>;
