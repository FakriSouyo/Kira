import type { ScreenerResult } from '@harness/financial-data';
import type { HarnessContext } from '../context';
import { financialToolIds, SCREEN_CAPABILITY_PRINCIPAL } from '@harness/engine';

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
  const results = (await ctx.capabilityGateway.invoke(
    SCREEN_CAPABILITY_PRINCIPAL,
    financialToolIds.screen,
    { criteria },
  )).value;
  return {
    criteria,
    results: results.filter((r) => r.matchScore > 0).slice(0, MAX_ROWS),
  };
}
