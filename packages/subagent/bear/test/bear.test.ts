import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { GenerateObjectParams, LLMCallMetadata, LLMClientLike } from '@harness/llm';
import type { Claim } from '@harness/schemas';
import { FilesystemSkillProvider } from '@harness/skill-filesystem';
import { SubagentRuntime } from '@harness/subagent-core';
import { BEAR_MANIFEST, BearAgent } from '../src/index.js';

const evidenceId = '77777777-7777-4777-8777-777777777777';
const claim: Claim = {
  claimId: 'claim_1',
  statement: 'Reported profitability supports the constructive thesis.',
  confidence: 'moderate',
  reasoning: 'The cited primary report shows profitable operations across the supplied period.',
  evidenceIds: [evidenceId],
};

function runtimeFor(targetClaimId: string, counterpointFields: Record<string, unknown> = {}): SubagentRuntime {
  const llm = {
    async generateObjectResult<T>(params: GenerateObjectParams<T>): Promise<{ value: T; metadata: LLMCallMetadata }> {
      return { value: params.schema.parse({
        reasoning: 'The constructive case depends on an assumption that needs further testing.',
        counterpoints: [{
          targetClaimId,
          argument: 'The available reporting window does not establish persistence.',
          strength: 'moderate',
          evidenceIds: [evidenceId],
          evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The supplied evidence covers only the observed reporting window.' }],
          ...counterpointFields,
        }],
        evidenceIds: [evidenceId],
      }), metadata: {
        provider: 'mock', model: 'bear-test', inputTokens: null, outputTokens: null,
        cachedInputTokens: null, totalTokens: null, finishReason: 'stop', latencyMs: 0,
      } };
    },
  } as LLMClientLike;
  return new SubagentRuntime(
    llm,
    new FilesystemSkillProvider(fileURLToPath(new URL('..', import.meta.url))),
  );
}

describe('BearAgent specialist', () => {
  it('owns only the adversarial-challenge skill and retains the mock marker', () => {
    expect(BEAR_MANIFEST.skills).toEqual(['skills/adversarial-challenge/SKILL.md']);
    expect(BEAR_MANIFEST.persona).toContain('Bear Agent');
  });

  it('challenges only claims supplied by Bull', async () => {
    const result = await new BearAgent(runtimeFor('claim_1')).challenge({
      ticker: 'BBCA',
      evidenceZone: 'STABLE EVIDENCE',
      bullClaims: [claim],
    });

    expect(result.value.counterpoints[0]).toMatchObject({
      targetClaimId: 'claim_1', evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies' }],
    });
    expect(result.skills).toHaveLength(1);
  });

  it('rejects model-owned Counterpoint identity and policy metadata', async () => {
    await expect(new BearAgent(runtimeFor('claim_1', { counterpointId: 'model-owned' })).challenge({
      ticker: 'BBCA', evidenceZone: 'STABLE EVIDENCE', bullClaims: [claim],
    })).rejects.toThrow();
    await expect(new BearAgent(runtimeFor('claim_1', { policyId: 'counterpoint-policy-v1' })).challenge({
      ticker: 'BBCA', evidenceZone: 'STABLE EVIDENCE', bullClaims: [claim],
    })).rejects.toThrow();
  });

  it('rejects an LLM counterpoint targeting an unknown Bull claim', async () => {
    await expect(new BearAgent(runtimeFor('invented_claim')).challenge({
      ticker: 'BBCA',
      evidenceZone: 'STABLE EVIDENCE',
      bullClaims: [claim],
    })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET_CLAIM' });
  });
});
