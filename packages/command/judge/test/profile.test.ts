import { describe, expect, it } from 'vitest';
import { createJudgeExecutionProfile } from '../src/profile';

const plan = {
  schemaVersion: 1,
  primary: { route: { providerId: 'openrouter', modelId: 'qwen/qwen3' }, descriptor: { runtimeFingerprint: 'a'.repeat(64) } },
  fallbacks: [],
  runtimeFingerprint: 'a'.repeat(64),
};

describe('Q2 Judge execution profiles', () => {
  it('pins a semantic runtime plan while retaining legacy provider/model fields', () => {
    const profile = createJudgeExecutionProfile({
      executionId: 'run-q2-profile', ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3', runtimePlan: plan,
      createdAt: '2026-09-20T00:00:00.000Z',
    });

    expect(profile.payload).toMatchObject({
      provider: 'openrouter', model: 'qwen/qwen3', runtimePlanFingerprint: 'a'.repeat(64), runtimePlan: plan,
    });
  });

  it('keeps old PR P profiles readable without a runtime plan', () => {
    const profile = createJudgeExecutionProfile({
      executionId: 'run-legacy-profile', ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openai', model: 'gpt-legacy',
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    expect(profile.payload).not.toHaveProperty('runtimePlan');
    expect(profile.payload).toMatchObject({ provider: 'openai', model: 'gpt-legacy' });
  });
});
