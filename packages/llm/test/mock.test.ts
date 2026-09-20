import { renderEvidenceBlock } from '@harness/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMClient, createMockModelRuntime } from '../src/index';

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
const BEAR_ZONE2 = 'You are Bear Agent, a skeptical financial analyst.';
const JUDGE_SYSTEM = 'You are Judge Agent, a neutral arbiter.';
const ROUTER_SYSTEM = 'You are Intent Router for Financial Agent Harness.';

const BEAR_OUTPUT_SCHEMA = z.object({
  reasoning: z.string().min(10),
  counterpoints: z
    .array(
      z.object({
        targetClaimId: z.string().min(1),
        argument: z.string().min(5),
        strength: z.enum(['high', 'moderate', 'low']),
      }),
    )
    .min(1),
  evidenceIds: z.array(z.string().uuid()),
});

/** Format prompt challenge milik specialist Bear. */
const BEAR_PROMPT = `You are a bearish analyst evaluating BBCA.

Bull Agent made the following claims:
1. Profitability remains strong. (claim: claim_1, Confidence: strong)
   Evidence: ${E1}
   Reasoning: ROE of 23.1% indicates strong profitability.
2. Earnings growth remains positive. (claim: claim_2, Confidence: moderate)
   Evidence: ${E2}
   Reasoning: Net income growing 8.7% YoY.

Challenge the bull thesis. The evidence is in the system context.`;

const REBUTTAL_PROMPT = `You are a bullish analyst defending your thesis for BBCA.

Bear Agent raised the following challenges:
1. Targets claim claim_1 (strength: moderate): High ROE may reflect leverage.
2. Targets claim claim_2 (strength: moderate): One quarter is not a trend.

Respond with your rebuttal. The evidence is in the system context.`;

describe('MockLLMClient — Intent Router', () => {
  const mock = new MockLLMClient();

  it('describes an explicit deterministic runtime plan', () => {
    const plan = mock.describeRuntimePlan();
    expect(plan.fallbacks).toEqual([]);
    expect(plan.primary.descriptor).toEqual(expect.objectContaining({
      providerId: 'mock',
      modelId: 'deterministic-financial-mock',
      adapterId: 'mock',
      protocol: 'mock',
      capabilities: expect.objectContaining({
        contextWindowTokens: 16_384,
        maxOutputTokens: 2_000,
        supportsTextInput: true,
        supportsStructuredOutput: true,
        supportsTextStreaming: true,
        supportsStructuredStreaming: true,
      }),
    }));
  });

  it('provides the same result-bearing runtime contract with explicit mock identity', async () => {
    const result = await mock.generateObjectResult({
      schema: INTENT_SCHEMA,
      prompt: 'Apakah BBCA layak dibeli?',
      system: ROUTER_SYSTEM,
    });
    expect(result.value.type).toBe('judge');
    expect(result.metadata).toEqual(expect.objectContaining({
      provider: 'mock', model: 'deterministic-financial-mock',
      providerId: 'mock', modelId: 'deterministic-financial-mock', adapterId: 'mock', protocol: 'mock',
      inputTokens: null, outputTokens: null, totalTokens: null,
    }));
  });

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

describe('MockModelRuntime', () => {
  it('uses the same one-shot prepared-call contract with explicit mock metadata', async () => {
    const runtime = createMockModelRuntime();
    const call = runtime.prepareCall({ providerId: 'mock', modelId: 'deterministic-financial-mock' }, { temperature: 0, maxOutputTokens: 100 });
    const result = await call.generateTextResult({ prompt: 'offline' });
    expect(result.metadata).toEqual(expect.objectContaining({
      providerId: 'mock', modelId: 'deterministic-financial-mock', adapterId: 'mock', protocol: 'mock',
      inputTokens: null, outputTokens: null, totalTokens: null,
    }));
    await expect(call.generateTextResult({ prompt: 'again' })).rejects.toMatchObject({ code: 'PREPARED_CALL_ALREADY_USED' });
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

describe('MockLLMClient — Bear (Phase 1)', () => {
  const mock = new MockLLMClient();

  it('targets the bull claim ids from the prompt, grounded in evidence numbers', async () => {
    const result = await mock.generateObject({
      schema: BEAR_OUTPUT_SCHEMA,
      prompt: BEAR_PROMPT,
      system: [BULL_ZONE1, BEAR_ZONE2],
    });

    expect(result.counterpoints).toHaveLength(2);
    expect(result.counterpoints[0].targetClaimId).toBe('claim_1');
    expect(result.counterpoints[1].targetClaimId).toBe('claim_2');
    // ROE 23.1% (>= 15) → skeptisisme terukur, bukan alarm penuh
    expect(result.counterpoints[0].argument).toContain('23.1');
    expect(result.counterpoints[0].strength).toBe('moderate');
    // Growth 8.7% (>= 7) → moderate
    expect(result.counterpoints[1].argument).toContain('8.7');
    expect(result.counterpoints[1].strength).toBe('moderate');
    expect(result.evidenceIds).toEqual([E1, E2]);
  });

  it('is deterministic across calls', async () => {
    const params = { schema: BEAR_OUTPUT_SCHEMA, prompt: BEAR_PROMPT, system: [BULL_ZONE1, BEAR_ZONE2] };
    expect(await mock.generateObject(params)).toEqual(await mock.generateObject(params));
  });
});

describe('MockLLMClient — Bull rebuttal (Phase 1)', () => {
  const mock = new MockLLMClient();

  it('switches to rebuttal mode on the debate marker and issues rebuttal_N claim ids', async () => {
    const result = await mock.generateObject({
      schema: BULL_OUTPUT_SCHEMA,
      prompt: REBUTTAL_PROMPT,
      system: [BULL_ZONE1, BULL_ZONE2],
    });

    expect(result.reasoning).toContain('address the challenges');
    expect(result.claims.map((c) => c.claimId)).toEqual(['rebuttal_1', 'rebuttal_2']);
  });

  it('stays in analysis mode (claim_N ids) without the debate marker', async () => {
    const result = await mock.generateObject({
      schema: BULL_OUTPUT_SCHEMA,
      prompt: 'You are a bullish analyst evaluating BBCA.',
      system: [BULL_ZONE1, BULL_ZONE2],
    });
    expect(result.claims.map((c) => c.claimId)).toEqual(['claim_1', 'claim_2']);
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

    // Momentum & risk = null (data market belum di-fetch)
    expect(result.breakdown.marketMomentum).toBeNull();
    expect(result.breakdown.risk).toBeNull();
    // Skor = rata-rata berbobot 25/20/20 (renormalisasi 65)
    const expected = Math.round((result.breakdown.financialHealth * 25 + result.breakdown.growth * 20 + result.breakdown.valuation * 20) / 65);
    expect(result.score).toBe(expected);
    expect(result.stance).toBe(expected > 60 ? 'bullish' : expected < 40 ? 'bearish' : 'neutral');
    expect(result.summary).toContain('not evaluated');
    expect(result.summary).toContain('No counterargument was presented');
  });

  it('recognizes the debate round when the conversation contains a Bear challenge', async () => {
    const result = await mock.generateObject({
      schema: JUDGE_OUTPUT_SCHEMA,
      prompt:
        'Ticker: BBCA\n\nFull conversation:\n' +
        'BULL (claim): thesis\nBEAR (challenge): I challenge the durability of the cited figures.\n\n' +
        'All claims:\n' +
        ['1. Profitability remains strong. (strong)', '2. Earnings growth remains positive. (moderate)'].join('\n'),
      system: JUDGE_SYSTEM,
    });

    expect(result.summary).toContain('debate round');
    expect(result.confidence).toBe('moderate'); // skeptisisme teruji → bukan 'high'
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

describe('MockLLMClient — Market & News (Phase 1, addendum §24-A)', () => {
  const mock = new MockLLMClient();
  const M = '77777777-cccc-4ccc-8ccc-777777777777'; // daily_transaction
  const S = '66666666-dddd-4ddd-8ddd-666666666666'; // sentiment
  const CONSTRUCTIVE = 'You are part of the Financial Agent Harness.\nAvailable evidence for BBCA:\n' +
    renderEvidenceBlock([
      { id: E1, source: 'sectors.company_report', data: { ticker: 'BBCA', financials: { roe: 23.1 } } },
      { id: M, source: 'sectors.daily_transaction', data: { ticker: 'BBCA', upDaysPct: 63, liquidityBand: 'high' } },
      { id: S, source: 'sectors.sentiment', data: { ticker: 'BBCA', aggregate: 0.7, distribution: { negative: 0.1 } } },
    ]);

  it('bull issues a momentum claim (market) and a risk claim (sentiment) when that evidence is seen', async () => {
    const result = await mock.generateObject({
      schema: BULL_OUTPUT_SCHEMA,
      prompt: 'You are a bullish analyst for BBCA.',
      system: [CONSTRUCTIVE, BULL_ZONE2],
    });
    const statements = result.claims.map((c) => c.statement).join(' ');
    expect(/Momentum/.test(statements)).toBe(true);
    expect(/Risk/.test(statements)).toBe(true);
    // momentum claim menautkan evidence daily_transaction; risk claim → sentiment
    const momentumClaim = result.claims.find((c) => /Momentum/.test(c.statement))!;
    const riskClaim = result.claims.find((c) => /Risk/.test(c.statement))!;
    expect(momentumClaim.evidenceIds).toContain(M);
    expect(riskClaim.evidenceIds).toContain(S);
  });

  it('judge fills marketMomentum & risk when claims mention them, else keeps them null', async () => {
    const withMarket = await mock.generateObject({
      schema: JUDGE_OUTPUT_SCHEMA,
      prompt:
        'Ticker: BBCA\nAll claims:\n1. Momentum is constructive for BBCA. (strong)\n2. Risk is elevated for BBCA. (strong)\n3. Fundamentals are solid. (strong)',
      system: JUDGE_SYSTEM,
    });
    expect(withMarket.breakdown.marketMomentum).toBe(78);
    expect(withMarket.breakdown.risk).toBe(35);

    const withoutMarket = await mock.generateObject({
      schema: JUDGE_OUTPUT_SCHEMA,
      prompt: 'Ticker: BBCA\nAll claims:\n1. Fundamentals are solid. (strong)',
      system: JUDGE_SYSTEM,
    });
    expect(withoutMarket.breakdown.marketMomentum).toBeNull();
    expect(withoutMarket.breakdown.risk).toBeNull();
  });
});

describe('MockLLMClient — extended workflow specialists', () => {
  const mock = new MockLLMClient();
  const schema = z.object({ summary: z.string().min(1) }).passthrough();

  it.each(['Researcher', 'Fundamentals', 'Market', 'Valuation', 'Risk'])('%s Agent has deterministic offline output', async (name) => {
    const value = await mock.generateObject({
      schema,
      prompt: 'Analyze BBCA using only supplied evidence.',
      system: [BULL_ZONE1, `You are the ${name} Agent.`],
    });
    expect(value.summary).toBeTruthy();
  });
});
