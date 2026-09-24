import { describe, expect, it, vi } from 'vitest';
import { createEngineCapabilityRuntime } from '@harness/engine';
import type { FinancialDataProvider, ScreenerResult } from '@harness/financial-data';
import { screenWorkflow } from '../src/workflows/screenWorkflow';
import type { HarnessContext } from '../src/context';

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
    const context = {
      capabilityGateway: capabilityRuntime.capabilityGateway,
    } as unknown as HarnessContext;

    await expect(screenWorkflow(context, ['profitable'])).resolves.toEqual({
      criteria: ['profitable'],
      results: rows.slice(1, 11),
    });
    expect(provider.screen).toHaveBeenCalledWith(['profitable']);
  });
});
