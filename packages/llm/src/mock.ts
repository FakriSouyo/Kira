import type { Claim, Intent } from '@harness/schemas';
import { normalizeJudgmentScore, stanceForScore } from '@harness/shared';
import { createHash } from 'node:crypto';
import type { GenerateObjectParams, GenerateTextParams, LLMCallMetadata, LLMClientLike, LLMResult, LLMTextStreamResult, StreamObjectParams, StreamTextParams } from './types';
import type { ModelAdapter, ModelInvocationMetadata, PreparedAdapterCall } from './adapter';
import type { ModelRuntimeDescriptor } from './descriptor';
import { ModelRuntime } from './model-runtime';
import { ProviderDirectory } from './provider-directory';

const MOCK_RUNTIME_FINGERPRINT = createHash('sha256').update('finharness:deterministic-financial-mock', 'utf8').digest('hex');

function mockMetadata(): LLMCallMetadata {
  return {
    provider: 'mock',
    model: 'deterministic-financial-mock',
    providerId: 'mock',
    modelId: 'deterministic-financial-mock',
    adapterId: 'mock',
    protocol: 'mock',
    runtimeFingerprint: MOCK_RUNTIME_FINGERPRINT,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
    finishReason: 'stop',
    latencyMs: 0,
  };
}

function mockRuntimeMetadata(descriptor: ModelRuntimeDescriptor): ModelInvocationMetadata {
  return {
    providerId: descriptor.providerId,
    modelId: descriptor.modelId,
    adapterId: descriptor.adapterId,
    protocol: descriptor.protocol,
    runtimeFingerprint: descriptor.runtimeFingerprint,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
    finishReason: 'stop',
    latencyMs: 0,
  };
}

/**
 * Mock LLM deterministik untuk development offline & E2E test
 * (flag `--mock-llm` / FINHARNESS_MOCK_LLM).
 *
 * Kontrak: output dipilih dari marker di system prompt (zona [2]):
 *   "Intent Router" → klasifikasi intent
 *   "Bull Agent"    → tesis bullish (dibangun DARI evidence block di zona [1]);
 *                     bila prompt berisi "Bear Agent raised the following
 *                     challenges" → mode rebuttal
 *   "Bear Agent"    → challenge (menarget klaim Bull dari prompt, angka dari evidence)
 *   "Judge Agent"   → judgment (dibangun dari claims di prompt; menyebut
 *                     debat bila conversation berisi challenge Bear)
 *   specialist marker Researcher/Fundamentals/Market/Valuation/Risk →
 *                     output evidence-addressable untuk workflow offline
 * Marker ini wajib dipertahankan di prompt agents.
 *
 * Output divalidasi dengan Zod schema pemanggil — bila mock menyimpang,
 * test gagal (bukan silent).
 */

interface MockEvidence {
  id: string;
  source: string;
  data: Record<string, unknown>;
}

/** Ekstrak objek JSON pertama mulai dari `from` dengan brace balancing (aman string). */
function extractJson(text: string, from: number): unknown | null {
  const start = text.indexOf('{', from);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Parse evidence block deterministik (format renderEvidenceBlock, addendum §17). */
function parseEvidenceBlock(system: string): MockEvidence[] {
  const out: MockEvidence[] = [];
  const re = /- Evidence ID: (\S+)\n  Source: (\S+)\n  Data: /g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(system)) !== null) {
    const data = extractJson(system, re.lastIndex);
    if (data !== null && typeof data === 'object') {
      out.push({ id: match[1], source: match[2], data: data as Record<string, unknown> });
    }
  }
  return out;
}

interface QuarterlyRow {
  period?: string;
  revenueGrowthYoy?: number;
  netIncomeGrowthYoy?: number;
}

function claimForEvidence(ticker: string, ev: MockEvidence, index: number, claimId: string = `claim_${index + 1}`): Claim {
  const financials = (ev.data.financials ?? null) as Record<string, unknown> | null;
  const quarters = (ev.data.quarters ?? null) as QuarterlyRow[] | null;

  if (financials) {
    const roe = typeof financials.roe === 'number' ? financials.roe : null;
    const netMargin = typeof financials.netMargin === 'number' ? financials.netMargin : null;
    const strong = (roe ?? 0) >= 15;
    return {
      claimId,
      statement: `The fundamentals of ${ticker} indicate a solid financial profile.`,
      confidence: strong ? 'strong' : 'moderate',
      reasoning:
        roe !== null
          ? `Company report data shows ROE of ${roe}%` +
            (netMargin !== null ? ` and a net margin of ${netMargin}%` : '') +
            ', indicating profitable and efficient operations for the company.'
          : `Company report data for ${ticker} shows a stable financial structure supporting the business.`,
      evidenceIds: [ev.id],
    };
  }

  if (Array.isArray(quarters) && quarters.length > 0) {
    const latest = quarters[0];
    const revGrowth = typeof latest.revenueGrowthYoy === 'number' ? latest.revenueGrowthYoy : null;
    const niGrowth = typeof latest.netIncomeGrowthYoy === 'number' ? latest.netIncomeGrowthYoy : null;
    const strong = (revGrowth ?? 0) >= 5;
    return {
      claimId,
      statement: `The earnings trajectory of ${ticker} has shown consistent growth.`,
      confidence: strong ? 'strong' : 'moderate',
      reasoning:
        revGrowth !== null
          ? `Quarterly financials show revenue growth of ${revGrowth}% YoY` +
            (niGrowth !== null ? ` and net income growth of ${niGrowth}% YoY` : '') +
            (latest.period ? ` in ${latest.period}` : '') +
            ', a positive and consistent earnings trend.'
          : `Quarterly financials for ${ticker} show positive earnings across the reported period.`,
      evidenceIds: [ev.id],
    };
  }

  return {
    claimId,
    statement: `The available ${ev.source} data for ${ticker} is broadly supportive.`,
    confidence: 'moderate',
    reasoning: `The ${ev.source} payload for ${ticker} contains no adverse signals in the reviewed fields.`,
    evidenceIds: [ev.id],
  };
}

interface BullOutput {
  reasoning: string;
  claims: Claim[];
  evidenceIds: string[];
}

/** Ekstrak nilai numerik dari data evidence bila ada. */
function num(data: Record<string, unknown>, key: string): number | null {
  return typeof data[key] === 'number' ? (data[key] as number) : null;
}

function generateBull(prompt: string, system: string): BullOutput {
  // buildBullPrompt: "... produce your analysis for <TICKER>."
  const tickerMatch = prompt.match(/\bfor\s+([A-Za-z]{2,6})\b/i);
  const ticker = (tickerMatch?.[1] ?? 'the company').toUpperCase();
  const evidence = parseEvidenceBlock(system);
  const isRebuttal = prompt.includes('Bear Agent raised the following challenges');

  // Kelompokkan evidence per domain (addendum §24-A): fundamental, market, news.
  const fundamental = evidence.filter(
    (e) => e.source === 'sectors.company_report' || e.source === 'sectors.quarterly_financials',
  );
  const market = evidence.filter((e) => e.source === 'sectors.daily_transaction' || e.source === 'sectors.foreign_flow');
  const news = evidence.filter((e) => e.source === 'sectors.sentiment');

  const claims: Claim[] = [];

  // 1) Klaim fundamental — dari company_report + quarterly_financials.
  for (const ev of fundamental.slice(0, 2)) {
    const c = claimForEvidence(ticker, ev, claims.length, isRebuttal ? `rebuttal_${claims.length + 1}` : `claim_${claims.length + 1}`);
    claims.push(c);
  }

  // 2) Klaim momentum — dari DailyTransaction/ForeignFlow (addendum §24-A.4).
  const marketIds = market.map((e) => e.id);
  const netBuyDays = market
    .map((e) => num(e.data, 'netBuyDaysPct') ?? num(e.data, 'upDaysPct'))
    .find((v) => v !== null);
  const daily = market.find((e) => e.source === 'sectors.daily_transaction');
  const foreign = market.find((e) => e.source === 'sectors.foreign_flow');
  if (marketIds.length > 0) {
    const momentumIsStrong = (netBuyDays ?? 0) >= 55;
    claims.push({
      claimId: isRebuttal ? `rebuttal_${claims.length + 1}` : `claim_${claims.length + 1}`,
      statement: `Momentum for ${ticker} is ${momentumIsStrong ? 'constructive' : 'moderate'} based on trading activity and foreign flow.`,
      confidence: momentumIsStrong ? 'strong' : 'moderate',
      reasoning: `Daily transaction and foreign-flow data for ${ticker} ` +
        (foreign?.data?.netFlow === 'buy' || foreign?.data?.netFlow === 'sell'
          ? `record net ${String(foreign.data.netFlow)} foreign flow`
          : `${netBuyDays ?? 'mixed'}% of days saw net buying`) +
        (daily && daily.data?.liquidityBand ? ` with ${String(daily.data.liquidityBand)} liquidity` : '') +
        ', supporting the momentum assessment for the stock.',
      evidenceIds: marketIds,
    });
  }

  // 3) Klaim risk — dari Sentiment (addendum §24-A.4).
  const sent = news[0];
  if (sent) {
    const aggregate = num(sent.data, 'aggregate');
    const dist = sent.data.distribution as { negative?: number } | null | undefined;
    const negative = typeof dist?.negative === 'number' ? dist.negative : null;
    const elevated = (aggregate ?? 0) < -0.2 || (negative ?? 0) > 0.35;
    claims.push({
      claimId: isRebuttal ? `rebuttal_${claims.length + 1}` : `claim_${claims.length + 1}`,
      statement: elevated
        ? `Risk is elevated for ${ticker} based on recent sentiment.`
        : `Risk appears contained for ${ticker} based on recent sentiment.`,
      confidence: elevated ? 'strong' : negative !== null && negative > 0.2 ? 'moderate' : 'weak',
      reasoning: `Aggregate sentiment for ${ticker} is ${aggregate ?? 'not negative'} ` +
        (aggregate !== null ? `(${aggregate > 0 ? 'positive' : 'negative'} bias)` : '') +
        ` with ${negative ?? 'no'} negative coverage, informing the risk assessment.`,
      evidenceIds: [sent.id],
    });
  }

  const finalClaims = claims.length > 0 ? claims : ([] as Claim[]);
  const highlights = claims.map((c) => c.reasoning).join(' ');

  const reasoning = isRebuttal
    ? `I stand by the bullish case for ${ticker} and address the challenges point by point. ` +
      `The cited figures (${highlights || 'the reviewed evidence'}) remain consistent with the ` +
      `fundamentals, and the concerns raised do not change the overall picture.`
    : `I see ${claims.length ? `${claims.length} supporting signals` : 'a stable position'} in the evidence for ${ticker}. ` +
      (highlights || 'The reviewed data points to a stable financial position.') +
      ` Taken together, these signals support a constructive view on ${ticker}.`;

  return {
    reasoning,
    claims: finalClaims.length > 0
      ? finalClaims
      : [
          {
            claimId: isRebuttal ? 'rebuttal_1' : 'claim_1',
            statement: `The reviewed data for ${ticker} shows no material red flags.`,
            confidence: 'moderate',
            reasoning: `The evidence attached to this run does not surface material adverse indicators for ${ticker}.`,
            evidenceIds: [evidence[0]?.id ?? 'evidence_unknown'],
          },
        ],
    evidenceIds: evidence.map((e) => e.id),
  };
}

interface BearOutput {
  reasoning: string;
  counterpoints: Array<{ targetClaimId: string; argument: string; strength: 'high' | 'moderate' | 'low' }>;
  evidenceIds: string[];
}

/**
 * Challenge deterministik: menarget klaim Bull pertama yang muncul di prompt
 * (baris "1. <statement> (claim: <id>, Confidence: <c>)") dan membangun
 * argumentasi dari angka evidence (ROE / growth) — selalu evidence-based.
 */
function generateBear(prompt: string, system: string): BearOutput {
  const evidence = parseEvidenceBlock(system);
  const claims: Array<{ id: string }> = [];
  const claimRe = /^\d+\.\s+.+?\(claim: (\S+?), Confidence: (strong|moderate|weak)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = claimRe.exec(prompt)) !== null) claims.push({ id: m[1] });

  let roe: number | null = null;
  let niGrowth: number | null = null;
  for (const ev of evidence) {
    const f = ev.data.financials as Record<string, unknown> | undefined;
    if (f && typeof f.roe === 'number') roe = f.roe;
    const q = ev.data.quarters as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(q) && q.length > 0 && typeof q[0].netIncomeGrowthYoy === 'number') {
      niGrowth = q[0].netIncomeGrowthYoy;
    }
  }

  const counterpoints: BearOutput['counterpoints'] = [];
  if (claims.length > 0) {
    const strength: 'high' | 'moderate' =
      roe !== null && roe >= 15 ? 'moderate' : niGrowth !== null && niGrowth < 5 ? 'high' : 'moderate';
    counterpoints.push({
      targetClaimId: claims[0].id,
      argument:
        roe !== null
          ? `A ROE of ${roe}% is strong, but high returns on equity can partly reflect leverage or a small equity base; ` +
            `the company report does not break out balance-sheet detail, so this figure warrants corroboration before it is treated as durable.`
          : `The cited evidence covers a single reporting snapshot; without multi-year trend data the robustness of the thesis is limited.`,
      strength,
    });
  }
  if (claims.length > 1) {
    counterpoints.push({
      targetClaimId: claims[1].id,
      argument:
        niGrowth !== null
          ? `Net income growth of ${niGrowth}% YoY is positive but rests on one quarterly print; ` +
            `a single-quarter reading does not establish the consistency the claim implies.`
          : `Growth is asserted from the latest period alone; earlier periods in the evidence do not clearly confirm a sustained trajectory.`,
      strength: niGrowth !== null && niGrowth >= 7 ? 'moderate' : 'high',
    });
  }

  return {
    reasoning:
      `My challenge to the bullish thesis is narrow and evidence-based rather than dismissive. ` +
      `${counterpoints.length === 1 ? 'The strongest single claim' : 'Several claims'} ` +
      `rest on a limited data window, and at least one figure (e.g. ` +
      `${roe !== null ? `ROE of ${roe}%` : 'the reported profitability metrics'}) ` +
      `would benefit from balance-sheet corroboration. The fundamentals are not weak — the debate is about durability.`,
    counterpoints: counterpoints.length > 0
      ? counterpoints
      : [
          {
            targetClaimId: 'claim_1',
            argument: 'The claims reference a single reporting period; durability is not established by the available evidence.',
            strength: 'low',
          },
        ],
    evidenceIds: evidence.map((e) => e.id),
  };
}

interface JudgeOutput {
  score: number;
  stance: 'bullish' | 'bearish' | 'neutral';
  confidence: 'high' | 'moderate' | 'low';
  breakdown: {
    financialHealth: number;
    growth: number;
    valuation: number;
    marketMomentum: number | null;
    risk: number | null;
  };
  summary: string;
}

interface PromptClaim {
  statement: string;
  confidence: 'strong' | 'moderate' | 'weak';
}

/** Parse seluruh klaim dari blok "All claims:" prompt Judge (format buildJudgePrompt). */
function parsePromptClaims(prompt: string): PromptClaim[] {
  const claims: PromptClaim[] = [];
  const re = /^\s*\d+\.\s+(.+?)\s+\((strong|moderate|weak)\)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(prompt)) !== null) {
    claims.push({ statement: match[1].trim(), confidence: match[2] as PromptClaim['confidence'] });
  }
  return claims;
}

/** Skor kategori dari confidence klaim (deterministik). */
function scoreFromConfidence(conf: PromptClaim['confidence']): number {
  return conf === 'strong' ? 78 : conf === 'moderate' ? 60 : 42;
}

/** Hitung jumlah klaim per confidence dari blok "All claims:" prompt Judge. */
function countClaimConfidences(prompt: string): { strong: number; moderate: number; weak: number } {
  const counts = { strong: 0, moderate: 0, weak: 0 };
  for (const c of parsePromptClaims(prompt)) counts[c.confidence] += 1;
  return counts;
}

function generateJudge(prompt: string): JudgeOutput {
  const { strong, moderate, weak } = countClaimConfidences(prompt);
  const total = strong + moderate + weak;

  // momentum & risk diisi dari klaim Bull yang menyebut momentum/sentimen-risk
  // (addendum §24-A.5): bila tidak ada klaim tsb → null (degradasi enrichment).
  let momentumConf: PromptClaim['confidence'] | null = null;
  let riskConf: PromptClaim['confidence'] | null = null;
  for (const c of parsePromptClaims(prompt)) {
    if (/momentum/i.test(c.statement)) momentumConf = c.confidence;
    if (/risk/i.test(c.statement)) riskConf = c.confidence;
  }

  const financialHealth = Math.min(95, 55 + 12 * strong + 6 * moderate + 2 * weak);
  const growth = Math.min(90, 50 + 10 * strong + 5 * moderate + 2 * weak);
  const valuation = Math.min(85, 45 + 8 * strong + 4 * moderate + 2 * weak);
  const marketMomentum = momentumConf ? scoreFromConfidence(momentumConf) : null;
  // Skor risk tinggi = risiko rendah; klaim risk "elevated/contained" dipetakan.
  const risk = riskConf ? (riskConf === 'strong' ? 35 : riskConf === 'moderate' ? 60 : 80) : null;
  const breakdown = { financialHealth, growth, valuation, marketMomentum, risk };
  const score = normalizeJudgmentScore(breakdown);
  const stance = stanceForScore(score);
  // Debat hadir → Bear menantang → kepastian turun satu tingkat (skeptisisme teruji).
  const bearChallenges = (prompt.match(/BEAR \(challenge\)/g) ?? []).length > 0;
  const confidence: JudgeOutput['confidence'] = bearChallenges
    ? 'moderate'
    : strong >= 2
      ? 'high'
      : total > 0
        ? 'moderate'
        : 'low';

  const debateLine = bearChallenges
    ? 'A debate round was held: Bear challenged the bull claims and Bull responded. ' +
      'I weighed the evidence-backed challenges against the rebuttal before scoring. '
    : 'No counterargument was presented in this run, so I evaluated the bull claims directly against the evidence. ';
  const marketLine =
    marketMomentum !== null || risk !== null
      ? `Market momentum and risk were evaluated from market & news evidence ` +
        `(momentum ${marketMomentum ?? 'n/a'}, risk ${risk ?? 'n/a'}).`
      : 'Market Momentum and Risk are not evaluated (no market/news data fetched); the overall score is renormalized over the scored categories only.';
  const summary =
    `I evaluated ${total} claim${total === 1 ? '' : 's'} from the Bull agent ` +
    `(${strong} strong, ${moderate} moderate, ${weak} weak). ` +
    debateLine +
    marketLine;

  return { score, stance, confidence, breakdown, summary };
}

function firstEvidence(system: string): MockEvidence {
  const evidence = parseEvidenceBlock(system)[0];
  if (!evidence) throw new Error('Mock specialist requires at least one evidence item');
  return evidence;
}

function generateResearcher(system: string) {
  const evidence = parseEvidenceBlock(system);
  return {
    summary: `Reviewed ${evidence.length} evidence item${evidence.length === 1 ? '' : 's'} for decision-relevant facts.`,
    findings: evidence.slice(0, 3).map((item) => ({ claim: `Relevant facts were found in ${item.source}.`, evidenceIds: [item.id], confidence: 'medium' as const })),
    sourceAssessments: evidence.map((item) => ({ evidenceId: item.id, quality: item.source.startsWith('sectors.') ? 'primary' as const : 'secondary' as const, rationale: 'The source is directly attached to this run.' })),
    gaps: [],
  };
}

function generateFundamentals(system: string) {
  const evidence = firstEvidence(system);
  return {
    summary: 'Profitability and growth were assessed from the supplied financial evidence.',
    insights: [
      { topic: 'profitability' as const, assessment: 'Reported profitability is supported by the company evidence.', direction: 'positive' as const, evidenceIds: [evidence.id] },
      { topic: 'growth' as const, assessment: 'The available reporting period supports a measured growth assessment.', direction: 'mixed' as const, evidenceIds: [evidence.id] },
    ],
    accountingFlags: [], gaps: [],
  };
}

function generateMarket(system: string) {
  const evidence = firstEvidence(system);
  return {
    summary: 'Market context was assessed from trading and flow evidence.', regime: 'stable' as const,
    signals: [{ dimension: 'price_trend' as const, assessment: 'The observed market window is stable.', signal: 'neutral' as const, evidenceIds: [evidence.id] }],
    caveats: ['The assessment is limited to the supplied observation window.'],
  };
}

function generateValuation(system: string) {
  const evidence = firstEvidence(system);
  return {
    summary: 'Valuation was assessed only from metrics present in the supplied evidence.', assessment: 'uncertain' as const,
    observations: [{ method: 'relative_multiple' as const, assessment: 'The available snapshot supports only a relative valuation observation.', evidenceIds: [evidence.id] }],
    assumptions: ['Comparable periods must be aligned.'], uncertainties: ['A complete peer set is not present.'],
  };
}

function generateRisk(system: string) {
  const evidence = firstEvidence(system);
  return {
    summary: 'Material downside paths were tested against the supplied evidence.',
    scenarios: [{ title: 'Growth normalization', trigger: 'Reported growth weakens materially.', impact: 'Expected earnings and valuation support would decline.', likelihood: 'unknown' as const, severity: 'medium' as const, evidenceIds: [evidence.id] }],
    failureConditions: [{ condition: 'The thesis fails if profitability deteriorates persistently.', observable: 'Multiple reporting periods show weaker profitability.', evidenceIds: [evidence.id] }],
    gaps: [],
  };
}

function routeIntent(text: string): Intent {
  const upper = text.toUpperCase();
  const tickers = upper.match(/\b[A-Z]{4}\b/g) ?? [];
  const ticker = tickers[0];

  // "BBCA vs BBRI" / "BBCA dibandingkan BBRI" → compare
  if (/\b(VS|V\/S|DIBANDINGKAN|COMPARE)\b/i.test(text) && tickers.length >= 2) {
    return { type: 'compare', confidence: 0.85, ticker: tickers[0], claim: text.trim() };
  }
  // "Is BBCA overvalued?" → challenge
  if (/\b(OVERVALUED|UNDERVALUED|BENERAN|CHALLENGE|CLAIM)\b/i.test(text)) {
    return { type: 'challenge', confidence: 0.8, ticker, claim: text.trim() };
  }
  // "Apakah BBCA layak dibeli?" → judge
  const wantsJudge = /\b(BELI|BELIKAN|LAYAK|ANALISIS|JUDGE|WORTH|BUY|INVEST)\b/i.test(text);
  if (wantsJudge && ticker) {
    return { type: 'judge', confidence: 0.9, ticker };
  }
  // "Saham apa yang konsisten tumbuh?" → screen
  if (/\b(TUMBUH|SCREEN|SCREENING|PROFITABLE|GROWING|LIST|SAHAM APA|REKOMENDASI)\b/i.test(text)) {
    const criteria = [
      /\b(PROFITABLE|PROFIT|UNTUNG|LABA)\b/i.test(text) ? 'profitable' : '',
      /\b(TUMBUH|GROWING|GROWTH)\b/i.test(text) ? 'growing' : '',
    ].filter(Boolean).join(' ');
    return criteria ? { type: 'screen', confidence: 0.85, criteria } : { type: 'clarification', confidence: 0.5, question: 'Screen profitable, growing, or both?' };
  }
  if (ticker && /\b(BBCA|BBRI|BMRI|BBNI)\b/.test(upper)) {
    return { type: 'judge', confidence: 0.75, ticker };
  }
  return {
    type: 'clarification',
    confidence: 0.5,
    question: 'Do you mean:\na) /judge TICKER — full analysis\nb) /screen CRITERIA — find stocks\nc) Something else?',
  };
}

export class MockLLMClient implements LLMClientLike {
  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    const output = this.generate(params.system, params.prompt);
    // Validasi terhadap schema pemanggil — mock yang menyimpang akan gagal di sini.
    return params.schema.parse(JSON.parse(JSON.stringify(output))) as T;
  }

  async generateObjectResult<T>(params: GenerateObjectParams<T>): Promise<LLMResult<T>> {
    return { value: await this.generateObject(params), metadata: mockMetadata() };
  }

  async streamObject<T>(params: StreamObjectParams<T>): Promise<T> {
    const output = await this.generateObject(params);
    const record = output as Record<string, unknown>;
    const field = typeof record.reasoning === 'string' ? 'reasoning' : typeof record.summary === 'string' ? 'summary' : undefined;
    if (field) {
      const text = record[field] as string;
      for (let i = 1; i <= 3; i++) params.onPartial?.({ ...record, [field]: text.slice(0, Math.ceil(text.length * i / 3)) } as Partial<T>);
    } else params.onPartial?.(output as Partial<T>);
    return output;
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    const system = Array.isArray(params.system) ? params.system.join('\n') : params.system ?? '';
    if (system.includes('Main FinHarness Agent')) {
      return this.mainAgentAnswer(params.prompt);
    }
    return `[mock-llm] ${params.prompt.slice(0, 120)}`;
  }

  async generateTextResult(params: GenerateTextParams): Promise<LLMResult<string>> {
    if (params.abortSignal?.aborted) {
      params.abortSignal.throwIfAborted();
    }
    return { value: await this.generateText(params), metadata: mockMetadata() };
  }

  /** Streaming deterministik (tanpa delay) — konsumen menerima beberapa yield. */
  async *streamText(params: StreamTextParams): AsyncIterable<string> {
    const system = Array.isArray(params.system) ? params.system.join('\n') : params.system ?? '';
    if (system.includes('Main FinHarness Agent')) {
      // Samakan dengan generateText supaya streaming conversation konsisten di mock.
      const answer = this.mainAgentAnswer(params.prompt);
      const step = Math.max(1, Math.ceil(answer.length / 3));
      for (let i = 0; i < answer.length; i += step) yield answer.slice(i, i + step);
      return;
    }
    yield '[mock-llm] ';
    yield params.prompt.slice(0, 40);
    yield params.prompt.slice(40, 80);
  }

  streamTextResult(params: StreamTextParams): LLMTextStreamResult {
    const chunks = this.streamText(params);
    return { chunks, metadata: (async () => mockMetadata())() };
  }

  /** Jawaban kanonik Main FinHarness Agent untuk prompt conversation (konsisten response & stream). */
  private mainAgentAnswer(prompt: string): string {
    const topic = prompt.match(/User question:\s*(.+)/i)?.[1] ?? 'pertanyaan finansial';
    return `${topic} adalah topik finansial yang bisa saya bantu jelaskan secara umum. Untuk jawaban berbasis data dan sumber terbaru, lanjutkan dengan /research ${topic}`;
  }

  private generate(system: string | string[] | undefined, prompt: string): unknown {
    const systemText = Array.isArray(system) ? system.join('\n') : system ?? '';
    if (systemText.includes('Intent Router')) return routeIntent(prompt);
    if (systemText.includes('Researcher Agent')) return generateResearcher(systemText);
    if (systemText.includes('Fundamentals Agent')) return generateFundamentals(systemText);
    if (systemText.includes('Market Agent')) return generateMarket(systemText);
    if (systemText.includes('Valuation Agent')) return generateValuation(systemText);
    if (systemText.includes('Risk Agent')) return generateRisk(systemText);
    if (systemText.includes('Bear Agent')) return generateBear(prompt, systemText);
    if (systemText.includes('Bull Agent')) return generateBull(prompt, systemText);
    if (systemText.includes('Judge Agent')) return generateJudge(prompt);
    throw new Error(
      'MockLLMClient: no recognized system-prompt marker (router or financial specialist)',
    );
  }
}

class MockModelAdapter implements ModelAdapter {
  readonly id = 'mock';

  constructor(private readonly client: MockLLMClient) {}

  prepareCall(params: { model: never; descriptor: ModelRuntimeDescriptor; connection?: unknown }): PreparedAdapterCall {
    const client = this.client;
    const metadata = () => mockRuntimeMetadata(params.descriptor);
    return {
      async generateObject<T>(request: GenerateObjectParams<T>) {
        return { value: await client.generateObject(request), metadata: metadata() };
      },
      async generateText(request: GenerateTextParams) {
        return { value: await client.generateText(request), metadata: metadata() };
      },
      streamText: (request: StreamTextParams) => ({
        chunks: client.streamText(request),
        metadata: Promise.resolve(metadata()),
      }),
      async streamObject<T>(request: StreamObjectParams<T>) {
        return { value: await client.streamObject(request), metadata: metadata() };
      },
    };
  }
}

/** First-class deterministic mock implementation of the prepared-call runtime contract. */
export function createMockModelRuntime(): ModelRuntime {
  const client = new MockLLMClient();
  return new ModelRuntime({
    directory: new ProviderDirectory([{
      descriptor: { id: 'mock', displayName: 'Deterministic financial mock', adapterId: 'mock', protocol: 'mock', endpointFingerprint: 'mock' },
      models: [{
        id: 'deterministic-financial-mock',
        displayName: 'Deterministic financial mock',
        capabilities: {
          contextWindowTokens: 16_384,
          maxOutputTokens: 2_000,
          supportsTextInput: true,
          supportsStructuredOutput: true,
          supportsTextStreaming: true,
          supportsStructuredStreaming: true,
          nativeStructuredOutput: true,
        },
      }],
    }]),
    adapters: [new MockModelAdapter(client)],
  });
}
