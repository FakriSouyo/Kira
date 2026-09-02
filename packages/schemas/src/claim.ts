import { z } from 'zod';

/**
 * Struktur claim yang dihasilkan LLM (addendum §16).
 * Konvensi penamaan: camelCase di TS/Zod ↔ snake_case di DB (dipetakan eksplisit di Drizzle).
 */
export const ClaimSchema = z.object({
  claimId: z.string(),
  statement: z.string().min(10),
  confidence: z.enum(['strong', 'moderate', 'weak']),
  reasoning: z.string().min(20),
  evidenceIds: z.array(z.string().uuid()).min(1),
});

export type Claim = z.infer<typeof ClaimSchema>;

/** Breakdown rubrik 5 kategori — marketMomentum & risk = null di Phase 0 (addendum §11/§15). */
export const BreakdownSchema = z.object({
  financialHealth: z.number().min(0).max(100),
  growth: z.number().min(0).max(100),
  valuation: z.number().min(0).max(100),
  marketMomentum: z.number().min(0).max(100).nullable(),
  risk: z.number().min(0).max(100).nullable(),
});

export type Breakdown = z.infer<typeof BreakdownSchema>;

export const JudgmentSchema = z.object({
  ticker: z.string(),
  score: z.number().int().min(0).max(100),
  stance: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.enum(['high', 'moderate', 'low']),
  breakdown: BreakdownSchema,
  summary: z.string(),
});

export type Judgment = z.infer<typeof JudgmentSchema>;
