import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '@harness/database';
import { MockLLMClient, type ModelRuntimePlan } from '@harness/llm';
import { buildContext, runtimeBudgetForPlan } from '../src/context';
import { loadConfig } from '../src/config';

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

  it('uses the mock runtime plan for Context budgeting instead of raw mock config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-mock-runtime-plan-'));
    const db = openDb({ homeDir: dir });
    const session = await db.sessions.createSession({
      sessionId: 'mock-budget-session',
      title: 'Mock budget',
      provider: 'mock',
      model: 'deterministic-financial-mock',
      reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: 'context', command: 'conversation' });
    await db.workingContext.commit({
      sessionId: session.id,
      expectedVersion: 0,
      sourceSequence: 1,
      updatedByTurnId: turn.id,
      patch: {
        userAssertions: [{ kind: 'USER_ASSERTION', id: 'assertion-1', text: 'A durable user assertion.', turnId: turn.id }],
      },
    });

    const plan = new MockLLMClient().describeRuntimePlan();
    const runtimePlan = {
      ...plan,
      primary: {
        ...plan.primary,
        descriptor: {
          ...plan.primary.descriptor,
          capabilities: { ...plan.primary.descriptor.capabilities, contextWindowTokens: 4_096, maxOutputTokens: 321 },
          generationControls: { ...plan.primary.descriptor.generationControls, maxOutputTokens: 321 },
        },
      },
    } satisfies ModelRuntimePlan;
    const describeRuntimePlan = vi.spyOn(MockLLMClient.prototype, 'describeRuntimePlan').mockReturnValue(runtimePlan);

    try {
      const config = loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });
      config.llm.agent = { ...config.llm.agent, contextWindowTokens: 12_000, maxTokens: 7 };
      const context = buildContext(db, config);
      const prepared = await context.conversationContext.prepare({
        sessionId: session.id,
        turnId: turn.id,
        message: 'What should I remember?',
      });

      expect(prepared?.diagnostics.budget.contextWindowTokens).toBe(4_096);
      expect(prepared?.diagnostics.budget.reservedOutputTokens).toBe(321);
    } finally {
      describeRuntimePlan.mockRestore();
      db.raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
