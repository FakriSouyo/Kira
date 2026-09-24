import type { ScreenerResult } from '@harness/financial-data';
import type { CapabilityGateway } from '@harness/capability';
import { SCREEN_CAPABILITY_PRINCIPAL } from '../capabilities/financial';
import { financialToolIds } from '../tools/financial';

/** Hasil /screen (addendum Task 15) — pola historis, bukan prediksi. */
export interface ScreenArtifacts {
  criteria: string[];
  results: ScreenerResult[];
}

/** Maximum number of rows returned by the Screen workflow. */
const MAX_ROWS = 10;

export async function screenWorkflow(
  capabilityGateway: CapabilityGateway,
  criteria: string[],
): Promise<ScreenArtifacts> {
  const results = (await capabilityGateway.invoke(
    SCREEN_CAPABILITY_PRINCIPAL,
    financialToolIds.screen,
    { criteria },
  )).value;
  return {
    criteria,
    results: results.filter((r: ScreenerResult) => r.matchScore > 0).slice(0, MAX_ROWS),
  };
}
