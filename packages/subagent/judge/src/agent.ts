import { JudgeLLMOutputSchema, type Claim, type Judgment } from '@harness/schemas';
import { normalizeJudgmentScore, stanceForScore } from '@harness/shared';
import { type SubagentResult, SubagentRuntime } from '@harness/subagent-core';
import type { SpecialistContextPacket } from '@harness/context';
import { JUDGE_MANIFEST } from './manifest.js';

export interface JudgeDiscussion { agent: string; type: string; content: string }
export interface JudgeRequest {
  ticker?: string; claims?: Claim[]; discussion?: JudgeDiscussion[]; evidenceZone?: string;
  availableCategories?: { marketMomentum: boolean; risk: boolean };
  context?: SpecialistContextPacket;
}
export class JudgeAgent {
  constructor(private readonly runtime: SubagentRuntime) {}
  async evaluate(request: JudgeRequest): Promise<SubagentResult<Judgment>> {
    const specialist = request.context?.specialist;
    const claimsValue = request.claims ?? [...(specialist?.bullClaims ?? []), ...(specialist?.rebuttalClaims ?? [])];
    const discussionValue = request.discussion ?? specialist?.discussion ?? [];
    const categories = request.availableCategories ?? specialist?.availableCategories;
    if (!categories) throw new Error('Judge request requires available categories');
    const discussion = discussionValue.map((item) => `${item.agent.toUpperCase()} (${item.type}): ${item.content}`).join('\n');
    const claims = claimsValue.map((claim, index) => `${index + 1}. ${claim.statement} (${claim.confidence})\n   Evidence: ${claim.evidenceIds.join(', ')}`).join('\n');
    const generated = await this.runtime.runObject({
      manifest: JUDGE_MANIFEST,
      ...(request.context ? { specialistContext: request.context } : { evidenceZone: request.evidenceZone }),
      prompt: `Ticker: ${specialist?.subject.ticker ?? request.ticker}\n\nFull conversation:\n${discussion}\n\nAll claims:\n${claims}\n\nEvaluate and produce the final judgment following the rubric.`,
      schema: JudgeLLMOutputSchema,
    });
    const breakdown = {
      ...generated.value.breakdown,
      marketMomentum: categories.marketMomentum ? generated.value.breakdown.marketMomentum : null,
      risk: categories.risk ? generated.value.breakdown.risk : null,
    };
    const score = normalizeJudgmentScore(breakdown);
    const unavailable = [
      !categories.marketMomentum ? 'Market data unavailable; momentum is not evaluated.' : '',
      !categories.risk ? 'News data unavailable; risk is not evaluated.' : '',
    ].filter(Boolean).join(' ');
    return {
      ...generated,
      value: { ticker: specialist?.subject.ticker ?? request.ticker ?? '', score, stance: stanceForScore(score), confidence: generated.value.confidence, breakdown, summary: [generated.value.summary, unavailable].filter(Boolean).join(' ') },
    };
  }
}
