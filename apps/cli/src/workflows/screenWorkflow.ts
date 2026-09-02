import type { ScreenerResult } from '@harness/sectors-api';
import type { HarnessContext } from '../context';

/** Hasil /screen (addendum Task 15) — pola historis, bukan prediksi. */
export interface ScreenArtifacts {
  criteria: string[];
  results: ScreenerResult[];
}

/** Batas baris yang ditampilkan (hindari flood terminal). */
const MAX_ROWS = 10;

export async function screenWorkflow(
  ctx: HarnessContext,
  criteria: string[],
): Promise<ScreenArtifacts> {
  const results = await ctx.sectors.screen(criteria);
  return {
    criteria,
    results: results.filter((r) => r.matchScore > 0).slice(0, MAX_ROWS),
  };
}
