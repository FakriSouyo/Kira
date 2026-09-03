import type { Claim, Intent } from '@harness/schemas';
import { normalizeJudgmentScore, stanceForScore } from '@harness/shared';
import type { GenerateObjectParams, GenerateTextParams, LLMClientLike } from './types';

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

function generateBull(prompt: string, system: string): BullOutput {
  // buildBullPrompt: "... produce your analysis for <TICKER>."
  const tickerMatch = prompt.match(/\bfor\s+([A-Za-z]{2,6})\b/i);
  const ticker = (tickerMatch?.[1] ?? 'the company').toUpperCase();
  const evidence = parseEvidenceBlock(system);
  const isRebuttal = prompt.includes('Bear Agent raised the following challenges');
  const claims = evidence.slice(0, 4).map((ev, i) =>
    claimForEvidence(ticker, ev, i, isRebuttal ? `rebuttal_${i + 1}` : `claim_${i + 1}`),
  );
  const highlights = claims.map((c) => c.reasoning).join(' ');

  const reasoning = isRebuttal
    ? `I stand by the bullish case for ${ticker} and address the challenges point by point. ` +
      `The cited figures (${highlights || 'the reviewed evidence'}) remain consistent with the ` +
      `fundamentals, and the concerns raised do not change the overall picture.`
    : `I see several positive signals in the ${evidence.length} pieces of evidence for ${ticker}. ` +
      (highlights || 'The reviewed data points to a stable financial position.') +
      ` Taken together, these signals support a constructive view on ${ticker}.`;

  return {
    reasoning,
    claims: claims.length > 0 ? claims : [
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

/** Hitung jumlah klaim per confidence dari blok "All claims:" prompt Judge. */
function countClaimConfidences(prompt: string): { strong: number; moderate: number; weak: number } {
  const counts = { strong: 0, moderate: 0, weak: 0 };
  const re = /^\s*\d+\.\s+.+?\s+\((strong|moderate|weak)\)\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(prompt)) !== null) {
    counts[match[1] as 'strong' | 'moderate' | 'weak'] += 1;
  }
  return counts;
}

function generateJudge(prompt: string): JudgeOutput {
  const { strong, moderate, weak } = countClaimConfidences(prompt);
  const total = strong + moderate + weak;

  const financialHealth = Math.min(95, 55 + 12 * strong + 6 * moderate + 2 * weak);
  const growth = Math.min(90, 50 + 10 * strong + 5 * moderate + 2 * weak);
  const valuation = Math.min(85, 45 + 8 * strong + 4 * moderate + 2 * weak);
  const breakdown = { financialHealth, growth, valuation, marketMomentum: null, risk: null };
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
  const summary =
    `I evaluated ${total} claim${total === 1 ? '' : 's'} from the Bull agent ` +
    `(${strong} strong, ${moderate} moderate, ${weak} weak). ` +
    debateLine +
    'Market Momentum and Risk are not yet evaluated (no market data fetched); the overall score ' +
    'is renormalized over the scored categories only.';

  return { score, stance, confidence, breakdown, summary };
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
    return { type: 'screen', confidence: 0.85, criteria: text.trim(), ticker };
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

  async generateText(params: GenerateTextParams): Promise<string> {
    return `[mock-llm] ${params.prompt.slice(0, 120)}`;
  }

  private generate(system: string | string[] | undefined, prompt: string): unknown {
    const systemText = Array.isArray(system) ? system.join('\n') : system ?? '';
    if (systemText.includes('Intent Router')) return routeIntent(prompt);
    if (systemText.includes('Bear Agent')) return generateBear(prompt, systemText);
    if (systemText.includes('Bull Agent')) return generateBull(prompt, systemText);
    if (systemText.includes('Judge Agent')) return generateJudge(prompt);
    throw new Error(
      'MockLLMClient: no recognized system-prompt marker (Intent Router / Bull Agent / Bear Agent / Judge Agent)',
    );
  }
}
