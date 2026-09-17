import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { GenerateObjectParams, LLMClientLike } from '@harness/llm';
import type { Claim } from '@harness/schemas';
import { FilesystemSkillProvider } from '@harness/skill-filesystem';
import { SubagentRuntime } from '@harness/subagent-core';
import { JUDGE_MANIFEST, JudgeAgent } from '../src/index.js';

const evidenceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const claim: Claim = { claimId: 'claim_1', statement: 'Profitability remains strong.', confidence: 'strong', reasoning: 'Reported profitability is positive and supported by primary evidence.', evidenceIds: [evidenceId] };

describe('JudgeAgent specialist', () => {
  it('owns evidence-weighing skill and retains the mock marker', () => {
    expect(JUDGE_MANIFEST.skills).toEqual(['skills/evidence-weighing/SKILL.md']);
    expect(JUDGE_MANIFEST.persona).toContain('Judge Agent');
  });
  it('overrides model score and stance with the locked deterministic rubric', async () => {
    const llm = { async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
      return params.schema.parse({ score: 1, stance: 'bearish', confidence: 'high', breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: 99, risk: 99 }, summary: 'Model narrative.' });
    } } as LLMClientLike;
    const runtime = new SubagentRuntime(llm, new FilesystemSkillProvider(fileURLToPath(new URL('..', import.meta.url))));
    const result = await new JudgeAgent(runtime).evaluate({
      ticker: 'BBCA', claims: [claim], discussion: [], evidenceZone: 'EVIDENCE',
      availableCategories: { marketMomentum: false, risk: false },
    });
    expect(result.value).toMatchObject({ score: 72, stance: 'bullish' });
    expect(result.value.breakdown).toMatchObject({ marketMomentum: null, risk: null });
    expect(result.skills).toHaveLength(1);
  });
});
