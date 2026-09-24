import { describe, expect, it, vi } from 'vitest';
import { createEngineCapabilityRuntime, screenWorkflow } from '@harness/engine';
import type { FinancialDataProvider, ScreenerResult } from '@harness/financial-data';

describe('Screen tool-runtime composition', () => {
  it('invokes financial.screen and retains only positive matches up to ten rows', async () => {
    const rows: ScreenerResult[] = Array.from({ length: 12 }, (_, index) => ({
      ticker: `T${index}`,
      matchScore: index === 0 ? 0 : index,
    }));
    const provider = {
      screen: vi.fn(async () => rows),
    } as unknown as FinancialDataProvider;
    const capabilityRuntime = createEngineCapabilityRuntime({
      financialData: provider,
      attachmentStore: {} as never,
      documentStore: {} as never,
      sessionId: 'test-session',
    });
    const criteria = ['profitable'];

    await expect(screenWorkflow(capabilityRuntime.capabilityGateway, criteria)).resolves.toEqual({
      criteria,
      results: rows.slice(1, 11),
    });
    expect(provider.screen).toHaveBeenCalledWith(criteria);
  });
});
