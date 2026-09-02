import { renderEvidenceBlock } from '@harness/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMClient } from '../src/index';

const BULL_OUTPUT_SCHEMA = z.object({
  reasoning: z.string().min(10),
  claims: z
    .array(
      z.object({
        claimId: z.string(),
        statement: z.string().min(10),
        confidence: z.enum(['strong', 'moderate', 'weak']),
        reasoning: z.string().min(20),
        evidenceIds: z.array(z.string().uuid()).min(1),
      }),
    )
    .min(1),
  evidenceIds: z.array(z.string().uuid()),
});

const JUDGE_OUTPUT_SCHEMA = z.object({
  score: z.number().int().min(0).max(100),
  stance: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.enum(['high', 'moderate', 'low']),
  breakdown: z.object({
    financialHealth: z.number().min(0).max(100),
    growth: z.number().min(0).max(100),
    valuation: z.number().min(0).max(100),
    marketMomentum: z.number().min(0).max(100).nullable(),
    risk: z.number().min(0).max(100).nullable(),
  }),
  summary: z.string(),
});

const INTENT_SCHEMA = z.object({
  type: z.enum(['judge', 'screen', 'challenge', 'compare', 'clarification']),
  confidence: z.number().min(0).max(1),
  ticker: z.string().optional(),
  criteria: z.string().optional(),
  claim: z.string().optional(),
  question: z.string().optional(),
});

const E1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const E2 = '22222222-bbbb-4bbb-8bbb-222222222222';

const EVIDENCE_BLOCK = renderEvidenceBlock([
  {
    id: E1,
    source: 'sectors.company_report',
    data: { ticker: 'BBCA', financials: { roe: 23.1, netMargin: 35.2 }, valuation: { pe: 4.6 } },
  },
  {
    id: E2,
    source: 'sectors.quarterly_financials',
    data: { ticker: 'BBCA', quarters: [{ period: '2024-Q4', revenueGrowthYoy: 9.8, netIncomeGrowthYoy: 8.7 }] },
  },
]);

const BULL_ZONE1 = `You are part of the Financial Agent Harness.\nAvailable evidence for BBCA:\n${EVIDENCE_BLOCK}`;
const BULL_ZONE2 = 'You are Bull Agent, an optimistic financial analyst.';
const JUDGE_SYSTEM = 'You are Judge Agent, a neutral arbiter.';
const ROUTER_SYSTEM = 'You are Intent Router for Financial Agent Harness.';

describe('MockLLMClient — Intent Router', () => {
  const mock = new MockLLMClient();

  it('routes "Apakah BBCA layak dibeli?" to judge with ticker', async () => {
    const intent = await mock.generateObject({ schema: INTENT_SCHEMA, prompt: 'Apakah BBCA layak dibeli?', system: ROUTER_SYSTEM });
    expect(intent.type).toBe('judge');
    expect(intent.ticker).toBe('BBCA');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('routes "Saham apa yang konsisten tumbuh?" to screen', async () => {
    const intent = await mock.generateObject({ schema: INTENT_SCHEMA, prompt: 'Saham apa yang konsisten tumbuh?', system: ROUTER_SYSTEM });
    expect(intent.type).toBe('screen');
  });

  it('routes "Is BBCA overvalued?" to challenge', async () => {
    const intent = await mock.generateObject({ schema: INTENT_SCHEMA, prompt: 'Is BBCA overvalued?', system: ROUTER_SYSTEM });
    expect(intent.type).toBe('challenge');
    expect(intent.ticker).toBe('BBCA');
  });

  it('routes "BBCA vs BBRI" to compare', async () => {
    const intent = await mock.generateObject({ schema: INTENT_SCHEMA, prompt: 'BBCA vs BBRI', system: ROUTER_SYSTEM });
    expect(intent.type).toBe('compare');
  });

  it('asks for clarification on ambiguous input', async () => {
    const intent = await mock.generateObject({ schema: INTENT_SCHEMA, prompt: 'hmm interesting', system: ROUTER_SYSTEM });
    expect(intent.type).toBe('clarification');
    expect(intent.question).toBeTruthy();
  });
});

describe('MockLLMClient — Bull', () => {
  const mock = new MockLLMClient();

  it('builds evidence-grounded claims referencing the real evidence IDs', async () => {
    const result = await mock.generateObject({
      schema: BULL_OUTPUT_SCHEMA,
      prompt: 'You are a bullish analyst evaluating BBCA.',
      system: [BULL_ZONE1, BULL_ZONE2],
    });

    expect(result.evidenceIds).toEqual([E1, E2]);
    expect(result.claims).toHaveLength(2);
    const referenced = new Set(result.claims.flatMap((c) => c.evidenceIds));
    expect(referenced).toEqual(new Set([E1, E2]));
    // Klaim pertama (company report) memakai angka riil dari data evidence
    expect(result.claims[0].reasoning).toContain('23.1');
    expect(result.claims[0].confidence).toBe('strong');
    // KLAIM pertumbuhan (quarterly) memakai angka YoY riil
    expect(result.claims[1].reasoning).toContain('9.8');
  });

  it('is deterministic across calls', async () => {
    const params = {
      schema: BULL_OUTPUT_SCHEMA,
      prompt: 'You are a bullish analyst evaluating BBCA.',
      system: [BULL_ZONE1, BULL_ZONE2],
    };
    expect(await mock.generateObject(params)).toEqual(await mock.generateObject(params));
  });
});

describe('MockLLMClient — Judge', () => {
  const mock = new MockLLMClient();

  const judgePrompt = (claimLines: string) =>
    `Ticker: BBCA\n\nAll claims:\n${claimLines}\n\nEvaluate and produce final judgment.`;

  it('produces a normalized score and aligned stance', async () => {
    const result = await mock.generateObject({
      schema: JUDGE_OUTPUT_SCHEMA,
      prompt: judgePrompt(
        ['1. Profitability remains strong. (strong)', '2. Earnings growth remains positive. (moderate)'].join('\n'),
      ),
      system: JUDGE_SYSTEM,
    });

    // Phase 0: momentum & risk = null
    expect(result.breakdown.marketMomentum).toBeNull();
    expect(result.breakdown.risk).toBeNull();
    // Skor = rata-rata berbobot 25/20/20 (renormalisasi 65)
    const expected = Math.round((result.breakdown.financialHealth * 25 + result.breakdown.growth * 20 + result.breakdown.valuation * 20) / 65);
    expect(result.score).toBe(expected);
    expect(result.stance).toBe(expected > 60 ? 'bullish' : expected < 40 ? 'bearish' : 'neutral');
    expect(result.summary).toContain('Phase 0');
  });

  it('scores more strong claims higher', async () => {
    const params = (lines: string[]) => ({
      schema: JUDGE_OUTPUT_SCHEMA,
      prompt: judgePrompt(lines.map((l, i) => `${i + 1}. ${l}`).join('\n')),
      system: JUDGE_SYSTEM,
    });
    const weak = await mock.generateObject(params(['A (weak)', 'B (weak)']));
    const strong = await mock.generateObject(params(['A (strong)', 'B (strong)']));
    expect(strong.score).toBeGreaterThan(weak.score);
  });
});
