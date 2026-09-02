import type { AgentMessage } from '@harness/conversation';
import { describe, expect, it } from 'vitest';
import { JudgeAgent } from '../src/index';
import { CLAIM_1, CLAIM_2, fakeLLM } from './fakes';

const CONVERSATION: AgentMessage[] = [
  {
    id: 'm1',
    runId: 'run_test',
    messageId: 'researcher_1',
    agent: 'researcher',
    messageType: 'observation',
    content: 'I retrieved the Company Report and Quarterly Financials.',
    evidenceIds: [],
    metadata: null,
    sequenceOrder: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
  },
];

describe('JudgeAgent', () => {
  it('recomputes the overall score from the breakdown (25/20/20 renormalized over 65)', async () => {
    const { llm } = fakeLLM({
      score: 99, // angka LLM diabaikan
      stance: 'bullish',
      confidence: 'high',
      breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
      summary: 'Consistent signals.',
    });
    const agent = new JudgeAgent(llm);

    const judgment = await agent.evaluate({ ticker: 'BBCA', claims: [CLAIM_1, CLAIM_2], conversation: CONVERSATION });

    // (80*25 + 65*20 + 70*20) / 65 = 4700/65 = 72.3 → 72
    expect(judgment.score).toBe(72);
    expect(judgment.stance).toBe('bullish'); // >60
    expect(judgment.ticker).toBe('BBCA');
    expect(judgment.breakdown.marketMomentum).toBeNull();
  });

  it('forces stance to align with the recomputed score', async () => {
    const { llm } = fakeLLM({
      score: 30,
      stance: 'bearish', // LLM berbohong
      confidence: 'low',
      breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
      summary: 'x'.repeat(20),
    });
    const agent = new JudgeAgent(llm);

    const judgment = await agent.evaluate({ ticker: 'BBCA', claims: [CLAIM_1], conversation: [] });
    expect(judgment.score).toBe(72);
    expect(judgment.stance).toBe('bullish'); // skor riil 72 > 60, bukan 'bearish'
  });

  it('neutral band: score 40-60 → neutral', async () => {
    const { llm } = fakeLLM({
      score: 50,
      stance: 'neutral',
      confidence: 'low',
      breakdown: { financialHealth: 50, growth: 50, valuation: 50, marketMomentum: null, risk: null },
      summary: 'x'.repeat(20),
    });
    const agent = new JudgeAgent(llm);

    const judgment = await agent.evaluate({ ticker: 'BBCA', claims: [], conversation: [] });
    expect(judgment.score).toBe(50);
    expect(judgment.stance).toBe('neutral');
  });

  it('prompt carries claims with confidence and evidence references', async () => {
    const { llm, calls } = fakeLLM({
      score: 72,
      stance: 'bullish',
      confidence: 'moderate',
      breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
      summary: 'ok',
    });
    const agent = new JudgeAgent(llm);

    await agent.evaluate({ ticker: 'BBCA', claims: [CLAIM_1, CLAIM_2], conversation: CONVERSATION });

    const prompt = calls[0].prompt as string;
    expect(prompt).toContain('Ticker: BBCA');
    expect(prompt).toContain('Profitability remains strong. (strong)');
    expect(prompt).toContain(CLAIM_1.evidenceIds[0]);
    expect(prompt).toContain('RESEARCHER (observation)');
  });
});
