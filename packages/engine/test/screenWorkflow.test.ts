import type { ScreenerResult } from '@harness/financial-data';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityGateway } from '@harness/capability';
import { SCREEN_CAPABILITY_PRINCIPAL } from '@harness/engine';
import { screenWorkflow } from '@harness/engine';

describe('Screen workflow', () => {
  it('uses the explicit Screen principal and financial.screen while preserving result behavior', async () => {
    const criteria = ['profitable', 'growing'];
    const rows: ScreenerResult[] = [
      { ticker: 'NEG', matchScore: -1 },
      { ticker: 'ZERO', matchScore: 0 },
      { ticker: 'HIGH', matchScore: 2 },
      { ticker: 'LOW', matchScore: 1 },
      ...Array.from({ length: 9 }, (_, index) => ({
        ticker: `T${index}`,
        matchScore: index + 3,
      })),
    ];
    const invoke = vi.fn(async () => ({
      value: rows,
      metadata: { toolId: 'financial.screen', durationMs: 1 },
    }));
    const capabilityGateway = { invoke } as unknown as CapabilityGateway;

    const artifacts = await screenWorkflow(capabilityGateway, criteria);
    expect(artifacts).toEqual({ criteria, results: rows.slice(2, 12) });
    expect(artifacts.criteria).toBe(criteria);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      SCREEN_CAPABILITY_PRINCIPAL,
      'financial.screen',
      { criteria },
    );
  });
});
