import { z } from 'zod';
import { BreakdownSchema, ClaimSchema } from '@harness/schemas';

/**
 * Output LLM untuk Bull Agent (addendum §15).
 * `messageId` ditambahkan agent (bukan LLM) — deterministik per panggilan.
 */
export const BullLLMOutputSchema = z.object({
  reasoning: z.string().min(10),
  claims: ClaimSchema.array().min(1),
  evidenceIds: z.array(z.string().uuid()),
});

export type BullLLMOutput = z.infer<typeof BullLLMOutputSchema>;

/** Respons murni BullAgent — workflow yang mem-persist-kan (addendum §04 prinsip 6). */
export interface BullAnalysisResponse extends BullLLMOutput {
  messageId: string;
}

/** Output LLM untuk Judge Agent — tanpa ticker (ticker diketahui workflow). */
export const JudgeLLMOutputSchema = z.object({
  score: z.number().int().min(0).max(100),
  stance: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.enum(['high', 'moderate', 'low']),
  breakdown: BreakdownSchema,
  summary: z.string(),
});

export type JudgeLLMOutput = z.infer<typeof JudgeLLMOutputSchema>;
