import { describe, expect, it } from 'vitest';
import type { ModelRuntimePlan } from '@harness/llm';
import { runtimeBudgetForPlan } from '../src/context';

function plan(maxOutputTokens: number, fallbackMaxOutputTokens: number[] = []): ModelRuntimePlan {
  const descriptor = (providerId: string, modelId: string, output: number, context: number, fingerprint: string) => ({
    schemaVersion: 1 as const,
    providerId,
    modelId,
    adapterId: 'openai-compatible',
    protocol: 'openai-chat',
    endpointFingerprint: 'endpoint',
    capabilities: {
      contextWindowTokens: context,
      maxOutputTokens: output,
      supportsTextInput: true,
      supportsStructuredOutput: true,
      supportsTextStreaming: true,
      supportsStructuredStreaming: true,
    },
    generationControls: { temperature: 0.2, maxOutputTokens: output },
    runtimeFingerprint: fingerprint,
  });
  const primary = { route: { providerId: 'provider-a', modelId: 'model-a' }, descriptor: descriptor('provider-a', 'model-a', maxOutputTokens, 16_384, 'a'.repeat(64)) };
  const fallbacks = fallbackMaxOutputTokens.map((output, index) => ({
    route: { providerId: `provider-${index + 1}`, modelId: `model-${index + 1}` },
    descriptor: descriptor(`provider-${index + 1}`, `model-${index + 1}`, output, 8_192, `${index + 1}`.repeat(64)),
  }));
  return {
    schemaVersion: 1,
    primary,
    fallbacks,
    runtimeFingerprint: 'p'.repeat(64),
  };
}

describe('production Context runtime-plan budget composition', () => {
  it('uses the resolved plan output limit instead of disagreeing raw config', () => {
    const rawConfigMaxTokens = 8_000;
    const budget = runtimeBudgetForPlan(plan(2_000));

    expect(rawConfigMaxTokens).toBe(8_000);
    expect(budget.reservedOutputTokens).toBe(2_000);
  });

  it('reserves the largest output capability across the ordered runtime plan', () => {
    const budget = runtimeBudgetForPlan(plan(2_000, [4_096, 1_024]));

    expect(budget.modelCapabilities).toMatchObject({
      contextWindowTokens: 16_384,
      fallbackContextWindowTokens: [8_192, 8_192],
    });
    expect(budget.reservedOutputTokens).toBe(4_096);
  });
});
