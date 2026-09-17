import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { GenerateObjectParams, LLMClientLike } from '@harness/llm';
import { FilesystemSkillProvider } from '@harness/skill-filesystem';
import { SubagentRuntime } from '@harness/subagent-core';
import { BULL_MANIFEST, BullAgent } from '../src/index.js';

const evidenceId = '66666666-6666-4666-8666-666666666666';

describe('BullAgent specialist', () => {
  it('owns only the evidence-backed-thesis skill and retains the mock marker', () => {
    expect(BULL_MANIFEST.skills).toEqual(['skills/evidence-backed-thesis/SKILL.md']);
    expect(BULL_MANIFEST.persona).toContain('Bull Agent');
  });

  it('builds a cited thesis and uses a distinct rebuttal prompt', async () => {
    const prompts: string[] = [];
    const llm = {
      async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
        prompts.push(params.prompt);
        const rebuttal = params.prompt.includes('Bear Agent raised the following challenges');
        return params.schema.parse({
          reasoning: rebuttal ? 'The challenge does not overturn the cited operating evidence.' : 'The evidence supports a constructive operating thesis.',
          claims: [{
            claimId: rebuttal ? 'rebuttal_1' : 'claim_1',
            statement: 'Reported profitability supports the constructive thesis.',
            confidence: 'moderate',
            reasoning: 'The cited primary report shows profitable operations across the supplied period.',
            evidenceIds: [evidenceId],
          }],
          evidenceIds: [evidenceId],
        });
      },
    } as LLMClientLike;
    const runtime = new SubagentRuntime(
      llm,
      new FilesystemSkillProvider(fileURLToPath(new URL('..', import.meta.url))),
    );
    const agent = new BullAgent(runtime);

    const thesis = await agent.analyze({ ticker: 'BBCA', evidenceZone: 'STABLE EVIDENCE' });
    const rebuttal = await agent.rebuttal({
      ticker: 'BBCA',
      evidenceZone: 'STABLE EVIDENCE',
      bearCounterpoints: [{ targetClaimId: 'claim_1', argument: 'Returns may not persist.', strength: 'moderate' }],
    });

    expect(thesis.value.claims[0]?.claimId).toBe('claim_1');
    expect(rebuttal.value.claims[0]?.claimId).toBe('rebuttal_1');
    expect(prompts[1]).toContain('Bear Agent raised the following challenges');
    expect(thesis.skills).toHaveLength(1);
  });
});
