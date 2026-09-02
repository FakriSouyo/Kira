import type { AgentMessage } from '@harness/conversation';
import type { Claim, Judgment } from '@harness/schemas';
import { normalizeJudgmentScore, stanceForScore } from '@harness/shared';
import type { LLMClientLike } from '@harness/llm';
import { JUDGE_SYSTEM_PROMPT } from './prompts/judge';
import { JudgeLLMOutputSchema, type JudgeLLMOutput } from './types';

/**
 * Judge Agent (addendum §15/Task 12) — pure function:
 * menilai klaim Bull terhadap rubrik 5 kategori. Phase 0: momentum & risk = null.
 *
 * Penegakan deterministik (di luar LLM):
 *   - `score` dihitung ulang dari breakdown (bobot renormalisasi) —
 *     aritmetika LLM tidak dapat diaudit; rumus §15 bersifat non-negotiable.
 *   - `stance` dipaksa align dengan skor (>60 bullish, <40 bearish, selain itu neutral).
 */
export class JudgeAgent {
  constructor(private readonly llm: LLMClientLike) {}

  async evaluate(params: {
    ticker: string;
    claims: Claim[];
    conversation: AgentMessage[];
  }): Promise<Judgment> {
    const output = await this.llm.generateObject<JudgeLLMOutput>({
      schema: JudgeLLMOutputSchema,
      system: JUDGE_SYSTEM_PROMPT,
      prompt: buildJudgePrompt(params),
    });

    const score = normalizeJudgmentScore(output.breakdown);
    return {
      ticker: params.ticker,
      score,
      stance: stanceForScore(score),
      confidence: output.confidence,
      breakdown: output.breakdown,
      summary: output.summary,
    };
  }
}

function buildJudgePrompt(params: {
  ticker: string;
  claims: Claim[];
  conversation: AgentMessage[];
}): string {
  const conversation = params.conversation
    .map((m) => `${m.agent.toUpperCase()} (${m.messageType}): ${m.content}`)
    .join('\n');
  const claims = params.claims
    .map((c, i) => `${i + 1}. ${c.statement} (${c.confidence})\n   Evidence: ${c.evidenceIds.join(', ')}`)
    .join('\n');

  return `Ticker: ${params.ticker}

Full conversation:
${conversation}

All claims:
${claims}

Evaluate and produce the final judgment following the rubrik in your instructions.`.trim();
}
