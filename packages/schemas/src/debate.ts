import { z } from 'zod';
import { ClaimSchema } from './claim.js';
import { BreakdownSchema } from './claim.js';

export const BullLLMOutputSchema = z.object({
  reasoning: z.string().min(10),
  claims: ClaimSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
});

export type BullLLMOutput = z.infer<typeof BullLLMOutputSchema>;

export const BearCounterpointSchema = z.object({
  targetClaimId: z.string().min(1),
  argument: z.string().min(5),
  strength: z.enum(['high', 'moderate', 'low']),
});

export type BearCounterpoint = z.infer<typeof BearCounterpointSchema>;

export const BearLLMOutputSchema = z.object({
  reasoning: z.string().min(10),
  counterpoints: BearCounterpointSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
});

export type BearLLMOutput = z.infer<typeof BearLLMOutputSchema>;

/** Raw Judge model output; score and stance are recomputed outside the model. */
export const JudgeLLMOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  stance: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.enum(['high', 'moderate', 'low']),
  breakdown: BreakdownSchema,
  summary: z.string(),
});

export type JudgeLLMOutput = z.infer<typeof JudgeLLMOutputSchema>;
