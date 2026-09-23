import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createCapabilityPlan } from '@harness/capability';
import { canonicalJson } from '@harness/shared';
import { createExecutionProfile } from '@harness/session-core';
import { createJudgeExecutionProfile } from '../src/profile';
import {
  classifyJudgeReleaseProfilePayload,
  JUDGE_RELEASE_CONTRACT,
  JUDGE_RELEASE_CONTRACT_FINGERPRINT,
  JUDGE_RELEASE_CONTRACT_ID,
  JUDGE_RELEASE_CONTRACT_VERSION,
} from '../src/release';
import {
  CLAIM_GRAPH_CONTRACT_FINGERPRINT,
  CLAIM_GRAPH_ID,
  CLAIM_GRAPH_VERSION,
  CLAIM_POLICY_FINGERPRINT,
  CLAIM_POLICY_ID,
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
} from '@harness/execution';

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

  it('pins the exact current policies, graph contract, and existing artifact schema', () => {
    const profile = createJudgeExecutionProfile({
      executionId: 'run-t5-profile', ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3',
      capabilityPlan, createdAt: '2026-09-20T00:00:00.000Z',
    });

    expect(JUDGE_RELEASE_CONTRACT_ID).toBe('judge-release-v1');
    expect(JUDGE_RELEASE_CONTRACT_VERSION).toBe(1);
    expect(JUDGE_RELEASE_CONTRACT).toEqual({
      id: JUDGE_RELEASE_CONTRACT_ID,
      version: 1,
      claimPolicy: { id: CLAIM_POLICY_ID, fingerprint: CLAIM_POLICY_FINGERPRINT },
      counterpointPolicy: { id: COUNTERPOINT_POLICY_ID, fingerprint: COUNTERPOINT_POLICY_FINGERPRINT },
      claimGraph: { id: CLAIM_GRAPH_ID, version: CLAIM_GRAPH_VERSION, fingerprint: CLAIM_GRAPH_CONTRACT_FINGERPRINT },
      artifacts: { kinds: ['BULL_CASE', 'BEAR_CASE', 'VERDICT'], schemaVersion: 1 },
      artifactGraphProjectionVersion: 1,
    });
    expect(JUDGE_RELEASE_CONTRACT_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
    expect(JUDGE_RELEASE_CONTRACT_FINGERPRINT).toBe(createHash('sha256').update(canonicalJson(JUDGE_RELEASE_CONTRACT), 'utf8').digest('hex'));
    expect(profile.payload.releaseContract).toEqual(JUDGE_RELEASE_CONTRACT);
    expect(profile.payload.releaseContractFingerprint).toBe(JUDGE_RELEASE_CONTRACT_FINGERPRINT);
    expect(classifyJudgeReleaseProfilePayload(profile.payload)).toBe('current');
    const { releaseContract: _contract, releaseContractFingerprint: _fingerprint, ...legacyPayload } = profile.payload;
    const legacyProfile = createExecutionProfile({
      executionId: profile.executionId, workflowId: profile.workflowId, workflowVersion: profile.workflowVersion,
      graphFingerprint: profile.graphFingerprint, command: profile.command, ticker: profile.ticker,
      payload: legacyPayload, createdAt: profile.createdAt,
    });
    expect(profile.fingerprint).not.toBe(legacyProfile.fingerprint);
  });

  it('classifies profiles with neither release marker as historical', () => {
    expect(classifyJudgeReleaseProfilePayload({ provider: 'openai', model: 'legacy' })).toBe('legacy');
  });

  it('fails closed when only one release marker exists or the current pin differs', () => {
    expect(() => classifyJudgeReleaseProfilePayload({ releaseContract: JUDGE_RELEASE_CONTRACT })).toThrow(/incomplete/);
    expect(() => classifyJudgeReleaseProfilePayload({ releaseContractFingerprint: JUDGE_RELEASE_CONTRACT_FINGERPRINT })).toThrow(/incomplete/);
    expect(() => classifyJudgeReleaseProfilePayload({
      releaseContract: JUDGE_RELEASE_CONTRACT,
      releaseContractFingerprint: '0'.repeat(64),
    })).toThrow(/unsupported/);
    expect(() => classifyJudgeReleaseProfilePayload({
      releaseContract: { ...JUDGE_RELEASE_CONTRACT, version: 2 },
      releaseContractFingerprint: JUDGE_RELEASE_CONTRACT_FINGERPRINT,
    })).toThrow(/unsupported/);
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
