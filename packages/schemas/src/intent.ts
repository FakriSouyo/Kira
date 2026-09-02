import { z } from 'zod';

/** Klasifikasi natural language → command (addendum §20). */
export const IntentSchema = z.object({
  type: z.enum(['judge', 'screen', 'challenge', 'compare', 'clarification']),
  confidence: z.number().min(0).max(1),
  ticker: z.string().optional(),
  criteria: z.string().optional(),
  claim: z.string().optional(),
  question: z.string().optional(),
});

export type Intent = z.infer<typeof IntentSchema>;
