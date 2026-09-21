import { describe, expect, it } from 'vitest';
import { createCapabilityPlan } from '@harness/capability';
import { createExecutionProfile } from '@harness/session-core';
import { createJudgeExecutionProfile } from '../src/profile';

const plan = {
  schemaVersion: 1,
  primary: { route: { providerId: 'openrouter', modelId: 'qwen/qwen3' }, descriptor: { runtimeFingerprint: 'a'.repeat(64) } },
  fallbacks: [],
  runtimeFingerprint: 'a'.repeat(64),
};

const capabilityPlan = createCapabilityPlan({ list: () => [] }, []);

describe('Q2 Judge execution profiles', () => {
  it('pins a semantic runtime plan while retaining legacy provider/model fields', () => {
    const profile = createJudgeExecutionProfile({
      executionId: 'run-q2-profile', ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3', runtimePlan: plan,
      capabilityPlan,
      createdAt: '2026-09-20T00:00:00.000Z',
    });

    expect(profile.payload).toMatchObject({
      provider: 'openrouter', model: 'qwen/qwen3', runtimePlanFingerprint: 'a'.repeat(64), runtimePlan: plan,
      capabilityPlan,
      capabilityPlanFingerprint: capabilityPlan.fingerprint,
    });
  });

  it('keeps old PR P profiles readable through the generic profile envelope', () => {
    const profile = createExecutionProfile({
      executionId: 'run-legacy-profile', ticker: 'BBCA',
      workflowId: 'judge', workflowVersion: 2, graphFingerprint: 'legacy-graph', command: 'judge',
      payload: { reasoningMode: 'usual', conditional: false, researchers: { market: true, news: true }, provider: 'openai', model: 'gpt-legacy' },
      createdAt: '2026-09-20T00:00:00.000Z',
    });
    expect(profile.payload).not.toHaveProperty('runtimePlan');
    expect(profile.payload).toMatchObject({ provider: 'openai', model: 'gpt-legacy' });
  });

  it('rejects a forged capability-plan fingerprint during Judge profile creation', () => {
    expect(() => createJudgeExecutionProfile({
      executionId: 'run-forged-capability-plan', ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3',
      capabilityPlan: { ...capabilityPlan, fingerprint: '0'.repeat(64) },
      createdAt: '2026-09-20T00:00:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY_PLAN' }));
  });
});
