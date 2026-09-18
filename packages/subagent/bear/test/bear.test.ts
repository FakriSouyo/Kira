import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { GenerateObjectParams, LLMClientLike } from '@harness/llm';
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

function runtimeFor(targetClaimId: string): SubagentRuntime {
  const llm = {
    async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
      return params.schema.parse({
        reasoning: 'The constructive case depends on an assumption that needs further testing.',
        counterpoints: [{
          targetClaimId,
          argument: 'The available reporting window does not establish persistence.',
          strength: 'moderate',
        }],
        evidenceIds: [evidenceId],
      });
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

    expect(result.value.counterpoints[0]?.targetClaimId).toBe('claim_1');
    expect(result.skills).toHaveLength(1);
  });

  it('rejects an LLM counterpoint targeting an unknown Bull claim', async () => {
    await expect(new BearAgent(runtimeFor('invented_claim')).challenge({
      ticker: 'BBCA',
      evidenceZone: 'STABLE EVIDENCE',
      bullClaims: [claim],
    })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET_CLAIM' });
  });
});
