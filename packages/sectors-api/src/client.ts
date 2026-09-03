import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileCache } from './cache';
import type {
  CompanyReport,
  DailyTransaction,
  Filing,
  ForeignFlow,
  NewsArticle,
  QuarterlyFinancials,
  SectorsApi,
  ScreenerResult,
  ScreenerRow,
  Sentiment,
} from './types';

export type SectorsErrorCode =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | 'NETWORK';

/** Error Sectors API dengan code yang dipetakan ke pesan ramah user (addendum §21). */
export class SectorsApiError extends Error {
  constructor(
    public readonly code: SectorsErrorCode,
    message: string,
    public readonly suggestion: string,
  ) {
    super(message);
    this.name = 'SectorsApiError';
  }
}

export interface SectorsApiOptions {
  apiKey?: string;
  /** Default https://api.sectors.app/v2 (v1 discontinued 2026-05-11). */
  baseUrl?: string;
  /** Default 30_000 ms. */
  timeoutMs?: number;
  /** Default 24 jam. */
  cacheTtlHours?: number;
  /** TTL khusus News (news/filings) — semi-volatil. Default 1 jam (addendum §24-A.6). */
  newsCacheTtlHours?: number;
  /** Default `<homeDir>/cache/sectors_api`. */
  cacheDir?: string;
  homeDir?: string;
  /** Injection untuk test (default: global fetch). */
  fetchImpl?: typeof fetch;
}

/** Skor match deterministik per kriteria (dipakai client & mock, addendum Task 15). */
export function computeMatchScore(row: ScreenerRow, criteria: string[]): number {
  let score = 0;
  for (const criterion of criteria) {
    const c = criterion.toLowerCase();
    if (c === 'profitable') {
      if ((row.roe ?? 0) > 0) score += 50;
    } else if (c === 'growing') {
      if ((row.revenueGrowthYoy ?? 0) > 0) score += 30;
      if ((row.netIncomeGrowthYoy ?? 0) > 0) score += 20;
    }
  }
  return Math.min(100, score);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function httpError(status: number, ticker: string | null): SectorsApiError {
  const label = ticker ? ` for ${ticker}` : '';
  if (status === 404) {
    return new SectorsApiError(
      'NOT_FOUND',
      ticker ? `Ticker "${ticker}" not found in Sectors API` : `Resource not found${label}`,
      'Try: /judge BBCA (or other valid ticker)',
    );
  }
  if (status === 401 || status === 403) {
    return new SectorsApiError(
      'UNAUTHORIZED',
      'Sectors API rejected the API key',
      'Check SECTORS_API_KEY in .env, ~/.finharness/.credentials.json, or /auth-set — atau gunakan --mock-sectors',
    );
  }
  if (status === 429) {
    return new SectorsApiError(
      'RATE_LIMIT',
      'Sectors API rate limit reached (429)',
      'Wait a moment and retry, or use the cached data / --mock-sectors',
    );
  }
  if (status >= 500) {
    return new SectorsApiError(
      'SERVER_ERROR',
      `Sectors API returned ${status}`,
      'Try again later, or use --mock-sectors for development',
    );
  }
  if (status === 400) {
    return new SectorsApiError('BAD_REQUEST', `Sectors API rejected the request (400)`, 'Check the command arguments');
  }
  return new SectorsApiError(
    'SERVER_ERROR',
    `Sectors API returned unexpected status ${status}`,
    'Try again later, or use --mock-sectors for development',
  );
}

/** Simbol IDX seri "BBCA.JK" → "BBCA". */
function stripSuffix(s: string | undefined): string {
  return (s ?? '').replace(/\.(JK|SGX|KLSE)$/i, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// BENTUK MENTAH v2 (internal — tidak bocor ke konsumen).
// Client menormalisasi v2 → bentuk canonical di packages/sectors-api/src/types.ts,
// sehingga konsumen (agent/workflow/renderer) tidak berubah.
// ─────────────────────────────────────────────────────────────────────────────

interface V2Report {
  symbol?: string;
  company_name?: string;
  overview?: { sector?: string; market_cap?: number; tags?: string[] };
  valuation?: {
    last_close_price?: number;
    latest_close_date?: string;
    forward_pe?: number;
    intrinsic_value?: number;
    historical_valuation?: Array<{ year?: number; pb?: number; pe?: number }>;
  };
  financials?: {
    eps?: number;
    yoy_quarter_earnings_growth?: number;
    yoy_quarter_revenue_growth?: number;
    historical_financials?: Array<{ year?: number; revenue?: number; earnings?: number; total_assets?: number; total_equity?: number }>;
  };
  dividend?: { historical_dividends?: Record<string, { total_yield?: number }> };
}

interface V2QuarterRow {
  symbol?: string;
  date?: string;
  revenue?: number;
  earnings?: number;
  ebitda?: number;
  total_equity?: number;
}

interface V2DailyRow {
  symbol?: string;
  date?: string;
  close?: number;
  open?: number;
  volume?: number;
  market_cap?: number;
}

interface V2ForeignFlow {
  symbol?: string;
  start?: string;
  end?: string;
  data?: Array<{ date?: string; net_foreign_inflow?: number }>;
}

interface V2NewsItem {
  title?: string;
  body?: string;
  source?: string;
  timestamp?: string;
  tags?: string[];
  symbols?: string[];
  dimension?: Record<string, number>;
}

interface V2FilingItem {
  title?: string;
  source?: string;
  timestamp?: string;
  symbol?: string;
  transaction_type?: string;
  holder_type?: string;
  holder_name?: string;
}

interface V2Paged<T> {
  results?: T[];
  pagination?: { total_count?: number; limit?: number; offset?: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transform v2 → canonical
// ─────────────────────────────────────────────────────────────────────────────

function pickLatestYear<T extends { year?: number }>(arr: T[]): T | undefined {
  let best: T | undefined;
  for (const el of arr ?? []) {
    if (!best || (el.year ?? 0) > (best.year ?? 0)) best = el;
  }
  return best;
}

function pickLatestKey<T>(map: Record<string, T>): T | undefined {
  let bestKey: number | null = null;
  let best: T | undefined;
  for (const key of Object.keys(map ?? {})) {
    const n = Number(key);
    if (bestKey === null || n > bestKey) {
      bestKey = n;
      best = map[key];
    }
  }
  return best;
}

const pct = (v: number | undefined): number | undefined => (v === undefined ? undefined : v * 100);

function toCompanyReport(raw: V2Report): CompanyReport {
  const fy = pickLatestYear(raw.financials?.historical_financials ?? []);
  const roe = fy?.total_equity ? (fy.earnings ?? 0) / fy.total_equity : undefined;
  const roa = fy?.total_assets ? (fy.earnings ?? 0) / fy.total_assets : undefined;
  const netMargin = fy?.revenue ? (fy.earnings ?? 0) / fy.revenue : undefined;
  const hv = raw.valuation?.historical_valuation ?? [];
  const pb = pickLatestYear(hv)?.pb;
  return {
    ticker: stripSuffix(raw.symbol),
    name: raw.company_name,
    sector: raw.overview?.sector,
    asOf: raw.valuation?.latest_close_date,
    financials: {
      roe: pct(roe),
      roa: pct(roa),
      netMargin: pct(netMargin),
      debtToEquity: undefined, // berasal dari report mendalam; dihindari fetch tambahan
      yoyQuarterRevenueGrowth: pct(raw.financials?.yoy_quarter_revenue_growth),
      yoyQuarterEarningsGrowth: pct(raw.financials?.yoy_quarter_earnings_growth),
    },
    valuation: {
      price: raw.valuation?.last_close_price,
      pe: raw.valuation?.forward_pe,
      pb,
      dividendYield: pct(pickLatestKey(raw.dividend?.historical_dividends ?? {})?.total_yield),
    },
  };
}

function periodOfDate(date: string | undefined): string {
  const parsed = /^(\d{4})-(\d{2})/.exec(date ?? '');
  if (!parsed) return date ?? '';
  const quarter = Math.min(4, Math.max(1, Math.ceil(Number(parsed[2]) / 3)));
  return `${parsed[1]}-Q${quarter}`;
}

function toQuarterlyFinancials(raw: V2QuarterRow[]): QuarterlyFinancials {
  const rows = [...(raw ?? [])].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  const quarters: QuarterlyFinancials['quarters'] = rows.map((r) => {
    const period = periodOfDate(r.date);
    const i = rows.indexOf(r);
    const prev = rows[i + 4]; // kuartal sama tahun sebelumnya
    return {
      period,
      revenue: r.revenue ?? 0,
      netIncome: r.earnings ?? 0,
      revenueGrowthYoy: prev && r.revenue ? pct((r.revenue - (prev.revenue ?? 0)) / (prev.revenue ?? 1)) : undefined,
      netIncomeGrowthYoy: prev && r.earnings ? pct((r.earnings - (prev.earnings ?? 0)) / (prev.earnings ?? 1)) : undefined,
    };
  });
  return { ticker: stripSuffix(rows[0]?.symbol), quarters };
}

function toScreenerRows(raw: V2Paged<V2ScreenerItem>): ScreenerRow[] {
  return (raw.results ?? []).map<ScreenRowMap>((r) => ({
    ticker: stripSuffix(r.symbol),
    name: r.company_name,
    roe: undefined, // v2 Companies tidak mengekspos `roe` langsung (catatan Deviasi)
    revenueGrowthYoy: r.yoy_quarter_revenue_growth,
    netIncomeGrowthYoy: r.yoy_quarter_earnings_growth,
    pe: r.forward_pe,
    pb: r.pb_mrq,
  }));
}

interface V2ScreenerItem {
  symbol?: string;
  company_name?: string;
  yoy_quarter_revenue_growth?: number;
  yoy_quarter_earnings_growth?: number;
  forward_pe?: number;
  pb_mrq?: number;
}

type ScreenRowMap = ScreenerRow;

function toDailyTransaction(raw: V2DailyRow[]): DailyTransaction {
  const rows = [...(raw ?? [])].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')));
  const count = rows.length;
  const upDays = rows.filter((r) => (r.close ?? 0) > (r.open ?? 0)).length;
  const avgValue = count ? rows.reduce((s, r) => s + (r.close ?? 0) * (r.volume ?? 0), 0) / count : 0;
  return {
    ticker: stripSuffix(rows[0]?.symbol),
    asOf: rows[count - 1]?.date ? `${rows[count - 1].date}T00:00:00Z` : '',
    window: `${count}d`,
    avgValueBillion: avgValue ? avgValue / 1_000_000_000 : undefined,
    volumeRatio: undefined,
    upDaysPct: count ? (upDays / count) * 100 : undefined,
    liquidityBand: undefined, // derivasi likuiditas membutuhkan konteks pasar; biarkan null
  };
}

function toForeignFlow(raw: V2ForeignFlow): ForeignFlow {
  const data = raw?.data ?? [];
  const netBuy = data.filter((d) => (d.net_foreign_inflow ?? 0) > 0).length;
  const sum = data.reduce((s, d) => s + (d.net_foreign_inflow ?? 0), 0);
  return {
    ticker: stripSuffix(raw.symbol),
    asOf: raw.end ? `${raw.end}T00:00:00Z` : '',
    window: `${data.length}d`,
    netForeignPctOfCap: undefined,
    netFlow: sum > 0 ? 'buy' : sum < 0 ? 'sell' : 'neutral',
    netBuyDaysPct: data.length ? (netBuy / data.length) * 100 : undefined,
  };
}

function sentimentOfTags(tags: string[] | undefined): 'positive' | 'negative' | 'neutral' {
  const t = (tags ?? []).join(' ').toLowerCase();
  if (t.includes('bearish') || t.includes('negative')) return 'negative';
  if (t.includes('bullish') || t.includes('positive')) return 'positive';
  return 'neutral';
}

function toNewsArticles(raw: V2Paged<V2NewsItem>, ticker: string): NewsArticle[] {
  return (raw.results ?? []).map((n, i) => ({
    id: `${stripSuffix(n.symbols?.[0]) ?? ticker}|${n.timestamp ?? ''}|${i}`,
    ticker: stripSuffix(n.symbols?.[0]) ?? ticker,
    headline: n.title ?? '',
    url: n.source,
    publishedAt: n.timestamp ?? '',
    snippet: (n.body ?? '').slice(0, 240),
    sentiment: sentimentOfTags(n.tags),
    source: 'sectors.news',
  }));
}

function toFilings(raw: V2Paged<V2FilingItem>, ticker: string): Filing[] {
  return (raw.results ?? []).map((f, i) => ({
    id: `${stripSuffix(f.symbol) ?? ticker}|${f.timestamp ?? ''}|${i}`,
    ticker: stripSuffix(f.symbol) ?? ticker,
    type: f.transaction_type ?? 'insider_transaction',
    title: f.title ?? '',
    filedAt: f.timestamp ?? '',
    url: f.source,
  }));
}

/** Turunan sentimen (keputusan: tanpa endpoint v2; dari news tags + foreign-flow sign). */
function deriveSentiment(ticker: string, news: NewsArticle[], foreign: ForeignFlow): Sentiment {
  let positive = 0;
  let negative = 0;
  let neutral = 0;
  for (const n of news) {
    if (n.sentiment === 'positive') positive += 1;
    else if (n.sentiment === 'negative') negative += 1;
    else neutral += 1;
  }
  const total = positive + negative + neutral;
  const newsAgg = total ? (positive - negative) / total : 0;
  // kesepakatan: aggregate = rata-rata sentimen berita + sinyal aliran asing (±0.5 bila non-netral)
  const foreignBias = foreign.netFlow === 'buy' ? 0.5 : foreign.netFlow === 'sell' ? -0.5 : 0;
  const aggregate = total ? (newsAgg + foreignBias) / 2 : foreignBias;
  return {
    ticker,
    asOf: foreign.asOf || (news[0] ? news[0].publishedAt : ''),
    window: foreign.window || `${Math.max(1, total)} articles`,
    aggregate,
    distribution: total ? { positive: positive / total, negative: negative / total, neutral: neutral / total } : undefined,
    articleCount: total,
  };
}

/**
 * Client HTTP Sectors API (addendum Task 6), API **v2**.
 * v1 discontinued pada 2026-05-11 (HTTP 410) — base URL `/v2`, auth memakai
 * header `Authorization: <key>` (TANPA prefix "Bearer"). Kontrak endpoint
 * terpusat di sini; response v2 dinormalisasi ke bentuk canonical types.ts
 * sehingga konsumen tidak berubah.
 */
export class SectorsClient implements SectorsApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly sdate: string;
  private readonly edate: string;
  private readonly cache: FileCache;
  private readonly newsCache: FileCache;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SectorsApiOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SECTORS_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://api.sectors.app/v2').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const homeDir = options.homeDir ?? process.env.FINHARNESS_HOME ?? join(homedir(), '.finharness');
    const cacheDir = options.cacheDir ?? join(homeDir, 'cache', 'sectors_api');
    this.cache = new FileCache(cacheDir, (options.cacheTtlHours ?? 24) * 3_600_000);
    this.newsCache = new FileCache(cacheDir, (options.newsCacheTtlHours ?? 1) * 3_600_000);
    // Default window 90 hari (batas maksimum v2 daily/foreign-flow).
    const end = new Date();
    const start = new Date(end.getTime() - 90 * 86_400_000);
    this.sdate = start.toISOString().slice(0, 10);
    this.edate = end.toISOString().slice(0, 10);
  }

  async getCompanyReport(ticker: string): Promise<CompanyReport> {
    return this.cached(this.cache, 'company_report', ticker, () =>
      this.request<V2Report>(`/company/report/${encodeURIComponent(ticker)}/`, ticker).then(toCompanyReport),
    );
  }

  async getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials> {
    return this.cached(this.cache, 'quarterly_financials', ticker, async () => {
      const raw = await this.request<V2QuarterRow[]>(`/financials/quarterly/${encodeURIComponent(ticker)}/`, ticker);
      const fin = toQuarterlyFinancials(raw);
      // Deviasi #17: v2 /financials/quarterly/ hanya 1 kuartal → YoY undefined.
      // Isi dari company_report.financials.yoy_quarter_*_growth (report sudah
      // di-fetch & cached di run normal; kalau belum, fetch via cache).
      if (fin.quarters.length > 0) {
        const q0 = fin.quarters[0];
        if (q0.revenueGrowthYoy === undefined || q0.netIncomeGrowthYoy === undefined) {
          try {
            const report = await this.getCompanyReport(ticker);
            if (q0.revenueGrowthYoy === undefined && report.financials.yoyQuarterRevenueGrowth !== undefined) {
              q0.revenueGrowthYoy = report.financials.yoyQuarterRevenueGrowth;
            }
            if (q0.netIncomeGrowthYoy === undefined && report.financials.yoyQuarterEarningsGrowth !== undefined) {
              q0.netIncomeGrowthYoy = report.financials.yoyQuarterEarningsGrowth;
            }
          } catch {
            // Report unavailable → biarkan undefined, rubrik akan renorm
          }
        }
      }
      return fin;
    });
  }

  async screen(criteria: string[]): Promise<ScreenerResult[]> {
    // v2 memakai /v2/companies/ (envelope {results,pagination}). Tanpa filter
    // `where=` utk input kriteria: ambil universe lalu skor client-side
    // (deterministis, konsisten dgn mock). Deviasi #14b mencatat `where` SQL
    // sebagai opsi lanjutan bila perlu.
    const rows = await this.request<V2Paged<V2ScreenerItem>>(`/companies/?limit=200`);
    return toScreenerRows(rows)
      .map((row) => ({ ...row, matchScore: computeMatchScore(row, criteria) }))
      .filter((r) => r.matchScore > 0)
      .sort((a, b) => b.matchScore - a.matchScore || a.ticker.localeCompare(b.ticker));
  }

  // —— Market Researcher (Phase 1, addendum §24-A.2) ——
  async getDailyTransaction(ticker: string): Promise<DailyTransaction> {
    return this.cached(this.cache, 'daily_transaction', ticker, () =>
      this.request<V2DailyRow[]>(
        `/daily/${encodeURIComponent(ticker)}/?start=${this.sdate}&end=${this.edate}`,
        ticker,
      ).then(toDailyTransaction),
    );
  }

  async getForeignFlow(ticker: string): Promise<ForeignFlow> {
    return this.cached(this.cache, 'foreign_flow', ticker, () =>
      this.request<V2ForeignFlow>(
        `/foreign-flow/${encodeURIComponent(ticker)}/?start=${this.sdate}&end=${this.edate}`,
        ticker,
      ).then(toForeignFlow),
    );
  }

  // —— News Researcher (Phase 1, addendum §24-A.2) — newsCache TTL lebih pendek.
  async getNews(ticker: string): Promise<NewsArticle[]> {
    return this.cached(this.newsCache, 'news', ticker, () =>
      this.request<V2Paged<V2NewsItem>>(`/news/?symbols=${encodeURIComponent(ticker)}&limit=20`, ticker).then((raw) =>
        toNewsArticles(raw, ticker),
      ),
    );
  }

  async getFilings(ticker: string): Promise<Filing[]> {
    return this.cached(this.newsCache, 'filings', ticker, () =>
      this.request<V2Paged<V2FilingItem>>(`/filings/?symbol=${encodeURIComponent(ticker)}&limit=10`, ticker).then(
        (raw) => toFilings(raw, ticker),
      ),
    );
  }

  /** Sentimen diturunkan (bukan endpoint v2): dari news tags + sign foreign-flow. */
  async getSentiment(ticker: string): Promise<Sentiment> {
    // getNews/getFilings memakai cache → umumnya tidak menambah call berbayar.
    const [news, foreign] = await Promise.all([this.getNews(ticker), this.getForeignFlow(ticker)]);
    return deriveSentiment(ticker, news, foreign);
  }

  /** Read-through cache: hit → langsung return; miss → fetch lalu simpan. */
  private async cached<T>(cache: FileCache, source: string, ticker: string, fetcher: () => Promise<T>): Promise<T> {
    const cacheKey = `${ticker.toUpperCase()}_${source}`;
    const hit = cache.get<T>(cacheKey);
    if (hit !== null) return hit;
    const data = await fetcher();
    cache.set(cacheKey, data);
    return data;
  }

  private async request<T>(path: string, ticker: string | null = null): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Accept: 'application/json',
          // v2: header polos, TANPA prefix "Bearer" (Bearer → 401).
          ...(this.apiKey ? { Authorization: this.apiKey } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new SectorsApiError(
          'TIMEOUT',
          `Sectors API timed out after ${this.timeoutMs}ms`,
          'Try again or use --mock-sectors for development',
        );
      }
      throw new SectorsApiError(
        'NETWORK',
        `Sectors API unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'Check your network connection, or use --mock-sectors for development',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) throw httpError(res.status, ticker);
    return (await res.json()) as T;
  }
}