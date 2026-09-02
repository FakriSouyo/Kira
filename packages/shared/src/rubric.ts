/**
 * Rubrik penilaian Judge — 5 kategori, bobot terkunci (addendum §15).
 * Phase 0: `marketMomentum` & `risk` = null (data Market belum di-fetch);
 * skor keseluruhan = rata-rata berbobot kategori yang dinilai saja
 * (bobot direnormalisasi proporsional, mis. 25/20/20 atas total 65).
 */
export const RUBRIC_WEIGHTS = {
  financialHealth: 25,
  growth: 20,
  valuation: 20,
  marketMomentum: 20,
  risk: 15,
} as const;

export type BreakdownLike = {
  financialHealth: number;
  growth: number;
  valuation: number;
  marketMomentum: number | null;
  risk: number | null;
};

/** Skor keseluruhan deterministik dari breakdown (renormalisasi bobot kategori non-null). */
export function normalizeJudgmentScore(breakdown: BreakdownLike): number {
  let total = 0;
  let weightSum = 0;
  for (const key of Object.keys(RUBRIC_WEIGHTS) as (keyof typeof RUBRIC_WEIGHTS)[]) {
    const value = breakdown[key];
    if (value !== null) {
      total += value * RUBRIC_WEIGHTS[key];
      weightSum += RUBRIC_WEIGHTS[key];
    }
  }
  if (weightSum === 0) return 0;
  return Math.round(total / weightSum);
}

/** Alignment stance ↔ skor (addendum §15: >60 bullish, <40 bearish, selain itu neutral). */
export function stanceForScore(score: number): 'bullish' | 'bearish' | 'neutral' {
  if (score > 60) return 'bullish';
  if (score < 40) return 'bearish';
  return 'neutral';
}
