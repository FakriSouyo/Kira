import type { ScreenerResult } from '@harness/financial-data';
import { describe, expect, it, vi } from 'vitest';
import { SCREEN_CAPABILITY_PRINCIPAL } from '@harness/engine';
import type { HarnessContext } from '../src/context';
import { screenWorkflow } from '../src/workflows/screenWorkflow';

describe('Screen capability migration', () => {
  it('uses the explicit Screen principal and financial.screen while preserving result behavior', async () => {
    const criteria = ['profitable', 'growing'];
    const rows: ScreenerResult[] = Array.from({ length: 13 }, (_, index) => ({
      ticker: `T${index}`,
      matchScore: index === 0 ? 0 : index,
    }));
    const invoke = vi.fn(async () => ({
      value: rows,
      metadata: { toolId: 'financial.screen', durationMs: 1 },
    }));
    const context = {
      capabilityGateway: { invoke },
    } as unknown as HarnessContext;

    await expect(screenWorkflow(context, criteria)).resolves.toEqual({
      criteria,
      results: rows.slice(1, 11),
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      SCREEN_CAPABILITY_PRINCIPAL,
      'financial.screen',
      { criteria },
    );
  });
});
