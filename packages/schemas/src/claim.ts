import { z } from 'zod';

/**
 * Figure yang dikutip LLM — wajib menyebut path evidence persis (P0.2 Numeric Grounding).
 * Memungkinkan validator mencocokkan angka di statement vs nilai di evidence.data.
 */
export const CitedFigureSchema = z.object({
  evidenceId: z.string().uuid(),
  path: z.string().min(1), // ex: "quarters[0].revenueGrowthYoy"
  value: z.number(),
  periodLabel: z.string().min(1), // ex: "Q2'26 standalone" atau "H1 2026 vs H1 2025"
});

export type CitedFigure = z.infer<typeof CitedFigureSchema>;

/**
 * Struktur claim yang dihasilkan LLM (addendum §16 + P0.2).
 * Konvensi penamaan: camelCase di TS/Zod ↔ snake_case di DB (dipetakan eksplisit di Drizzle).
 */
export const ClaimSchema = z.object({
  claimId: z.string(),
  statement: z.string().min(10),
  confidence: z.enum(['strong', 'moderate', 'weak']),
  reasoning: z.string().min(20),
  evidenceIds: z.array(z.string().uuid()).min(1),
  /** P0.2: angka yang dikutip — opsional untuk backward-compat, tapi LLM diminta isi bila klaim berisi angka. */
  citedFigures: z.array(CitedFigureSchema).optional(),
  /**
   * P1.1 Multi-Metric Reconciliation — flag deterministik yang DIPERHITUNGKAN
   * `ClaimValidator` (bukan dari LLM): `true` bila klaim hanya mengutip SATU sisi
   * dari pasangan metrik (quarterly vs cumulativeYtd, distribution vs aggregate,
   * short vs long foreign window) padahal sisi lain juga tersedia di evidence-nya
   * (anti cherry-picking, addendum §15). Opsional untuk backward-compat — claim
   * lama tanpa anotasi ini tetap valid.
   */
  singleMetric: z.boolean().optional(),
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
