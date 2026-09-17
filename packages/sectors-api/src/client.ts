import { homedir } from 'node:os';
import { join } from 'node:path';
import { FileCache, type CacheEntryMeta } from './cache';
import {
  cacheKeyFor,
  evaluateCacheEntry,
  type CacheDecision,
  type SectorsCacheRequirement,
} from './policy';
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
  /** Injection waktu untuk pengujian freshness/cache; default waktu sekarang. */
  now?: () => Date;
  /** Observer read-only untuk keputusan `reuse`/`fetch` cache yang dapat diaudit. */
  onCacheDecision?: (decision: CacheDecision) => void;
}

const COMPANY_REPORT_SECTIONS = ['overview', 'valuation', 'financials', 'dividend'] as const;
const CACHE_SCHEMA_VERSION = 1;
const CACHE_ADAPTER_VERSION = 'v2';

function normalizeTicker(ticker: string): string {
  return ticker.toUpperCase();
}

function formatLocalDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function requirement(
  operation: string,
  ticker: string,
  params: Record<string, unknown>,
  temporal: SectorsCacheRequirement['temporal'],
): SectorsCacheRequirement {
  return {
    provider: 'sectors-api',
    operation,
    subjectScope: 'symbol',
    subject: normalizeTicker(ticker),
    params,
    temporal,
    schemaVersion: CACHE_SCHEMA_VERSION,
    adapterVersion: CACHE_ADAPTER_VERSION,
  };
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

/**
 * Build `where` SQL untuk Sectors v2 `/companies/?where=...` (Phase 3).
 * Mapping: `profitable → roe>0`, `growing → yoy_quarter_revenue_growth>0`.
 * Kriteria tak dikenal → diabaikan; bila tidak ada yang dikenal → null (fallback client-side).
 */
export function buildWhereClause(criteria: string[]): string | null {
  const parts: string[] = [];
  for (const c of criteria) {
    const lc = c.toLowerCase();
    if (lc === 'profitable') parts.push('roe>0');
    else if (lc === 'growing') parts.push('yoy_quarter_revenue_growth>0');
  }
  if (parts.length === 0) return null;
  return parts.join(' AND ');
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
  const byPeriod = new Map(rows.map((row) => [periodOfDate(row.date), row]));
  const growth = (current?: number, previous?: number): number | undefined =>
    current !== undefined && previous !== undefined && previous !== 0
      ? pct((current - previous) / Math.abs(previous)) : undefined;
  const quarters: QuarterlyFinancials['quarters'] = rows.map((r) => {
    const period = periodOfDate(r.date);
    const prev = byPeriod.get(`${Number(period.slice(0, 4)) - 1}${period.slice(4)}`);
    return {
      period,
      periodType: 'single_quarter' as const,
      revenue: r.revenue ?? 0,
      netIncome: r.earnings ?? 0,
      revenueGrowthYoy: growth(r.revenue, prev?.revenue),
      netIncomeGrowthYoy: growth(r.earnings, prev?.earnings),
    };
  });
  // YTD is only defined with every Q1..latest quarter in both calendar years.
  let cumulativeYtd: QuarterlyFinancials['cumulativeYtd'];
  const latest = /^(\d{4})-Q([1-4])$/.exec(quarters[0]?.period ?? '');
  if (latest) {
    const year = Number(latest[1]);
    const quarter = Number(latest[2]);
    const current = Array.from({ length: quarter }, (_, i) => byPeriod.get(`${year}-Q${i + 1}`));
    const previous = Array.from({ length: quarter }, (_, i) => byPeriod.get(`${year - 1}-Q${i + 1}`));
    if ([...current, ...previous].every((row) => row && row.revenue !== undefined && row.earnings !== undefined)) {
      const sum = (set: Array<V2QuarterRow | undefined>, field: 'revenue' | 'earnings') => set.reduce((total, row) => total + row![field]!, 0);
      const period = quarter === 2 ? 'H1' : quarter === 4 ? 'FY' : `YTD Q${quarter}`;
      cumulativeYtd = {
        periodLabel: `${year} ${period} vs ${year - 1} ${period}`,
        revenueGrowthYoy: growth(sum(current, 'revenue'), sum(previous, 'revenue')),
        netIncomeGrowthYoy: growth(sum(current, 'earnings'), sum(previous, 'earnings')),
      };
    }
  }
  return { ticker: stripSuffix(rows[0]?.symbol), quarters, ...(cumulativeYtd ? { cumulativeYtd } : {}) };
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
  private readonly periodicCache: FileCache;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly newsCacheTtlMs: number;
  private readonly onCacheDecision?: (decision: CacheDecision) => void;

  constructor(options: SectorsApiOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SECTORS_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://api.sectors.app/v2').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = (options.cacheTtlHours ?? 24) * 3_600_000;
    this.newsCacheTtlMs = (options.newsCacheTtlHours ?? 1) * 3_600_000;
    this.onCacheDecision = options.onCacheDecision;
    const homeDir = options.homeDir ?? process.env.FINHARNESS_HOME ?? join(homedir(), '.finharness');
    const cacheDir = options.cacheDir ?? join(homeDir, 'cache', 'sectors_api');
    // Sectors quotas are conserved by one snapshot per local calendar date.
    // A new date invalidates the snapshot even when fewer than 24 hours elapsed.
    this.cache = new FileCache(cacheDir, this.cacheTtlMs, { calendarDay: true, now: this.now });
    // News/filings are short-TTL recent/event data; calendar-day reuse would
    // incorrectly retain a stale response across the configured TTL.
    this.newsCache = new FileCache(cacheDir, this.newsCacheTtlMs, { now: this.now });
    // Company report is mixed identity/valuation/fundamental data, and latest
    // financials need bounded revalidation. Keep one conservative configurable
    // window rather than applying long-lived profile freshness to the whole entry.
    this.periodicCache = new FileCache(cacheDir, this.cacheTtlMs, { now: this.now });
    // Daily/foreign-flow docs permit `end=today` but do not guarantee that the
    // current trading day's row is immutable. End yesterday so this calendar-
    // day cache contains only completed historical sessions.
    const end = new Date(this.now());
    end.setDate(end.getDate() - 1);
    const start = new Date(end.getTime() - 90 * 86_400_000);
    this.sdate = formatLocalDate(start);
    this.edate = formatLocalDate(end);
  }

  async getCompanyReport(ticker: string): Promise<CompanyReport> {
    const symbol = normalizeTicker(ticker);
    const req = requirement('company_report', symbol, { sections: [...COMPANY_REPORT_SECTIONS] }, { kind: 'mixed_snapshot' });
    return this.cached(this.periodicCache, req,
      () =>
        this.request<V2Report>(`/company/report/${encodeURIComponent(symbol)}/?sections=${encodeURIComponent(COMPANY_REPORT_SECTIONS.join(','))}`, symbol).then(toCompanyReport),
      // Company Report is mixed identity/valuation/reference-date data; its
      // market reference date is not a financial reporting period.
      (d) => ({ dataAsOf: d.asOf, source: 'sectors-api' }),
    );
  }

  async getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials> {
    const symbol = normalizeTicker(ticker);
    const req = requirement('quarterly_financials', symbol, { approx: true, nQuarters: 1 }, { kind: 'latest_period' });
    return this.cached(this.periodicCache, req, async () => {
      let fin = await this.fetchQuarterly(symbol, 1);
      fin = await this.fillQuarterlyGrowth(symbol, fin);
      // A one-row response is correct when the report supplies YoY. If that
      // dependency is absent, retain the old multi-row derivation as a safe
      // fallback instead of silently degrading analytical correctness.
      if (fin.quarters[0]
        && (fin.quarters[0].revenueGrowthYoy === undefined || fin.quarters[0].netIncomeGrowthYoy === undefined)) {
        fin = await this.fetchQuarterly(symbol, 5);
        fin = await this.fillQuarterlyGrowth(symbol, fin);
      }
      return fin;
    }, (data: QuarterlyFinancials) => ({ dataAsOf: data.quarters[0]?.period, period: data.quarters[0]?.period, source: 'sectors-api' }));
  }

  private async fetchQuarterly(ticker: string, nQuarters: number): Promise<QuarterlyFinancials> {
    const raw = await this.request<V2QuarterRow[]>(
      `/financials/quarterly/${encodeURIComponent(ticker)}/?n_quarters=${nQuarters}&approx=true`,
      ticker,
    );
    return toQuarterlyFinancials(raw);
  }

  private async fillQuarterlyGrowth(ticker: string, fin: QuarterlyFinancials): Promise<QuarterlyFinancials> {
    if (fin.quarters.length === 0) return fin;
    const q0 = fin.quarters[0];
    if (q0.revenueGrowthYoy !== undefined && q0.netIncomeGrowthYoy !== undefined) return fin;
    try {
      const report = await this.getCompanyReport(ticker);
      if (q0.revenueGrowthYoy === undefined && report.financials.yoyQuarterRevenueGrowth !== undefined) {
        q0.revenueGrowthYoy = report.financials.yoyQuarterRevenueGrowth;
      }
      if (q0.netIncomeGrowthYoy === undefined && report.financials.yoyQuarterEarningsGrowth !== undefined) {
        q0.netIncomeGrowthYoy = report.financials.yoyQuarterEarningsGrowth;
      }
    } catch {
      // Report unavailable → biarkan undefined, rubrik akan renorm.
    }
    return fin;
  }

  async screen(criteria: string[]): Promise<ScreenerResult[]> {
    const scoreRows = async (data: V2Paged<V2ScreenerItem>): Promise<ScreenerResult[]> => {
      let rows = toScreenerRows(data);
      if (criteria.some((c) => c.toLowerCase() === 'profitable')) {
        // The companies endpoint omits ROE. Bound report enrichment to ten
        // candidates, ranked by known growth signals; reuse the normal report cache.
        // Enrichment paralel + toleran gagal per-ticker agar satu 404 tidak merusak screening.
        const candidates = rows
          .sort((a, b) => computeMatchScore(b, criteria) - computeMatchScore(a, criteria) || a.ticker.localeCompare(b.ticker))
          .slice(0, 10);
        const enriched = await Promise.all(
          candidates.map(async (row) => {
            if (row.roe !== undefined) return row;
            try {
              const report = await this.getCompanyReport(row.ticker);
              return { ...row, roe: report.financials.roe };
            } catch {
              return row; // biarkan roe undefined → profitable tetap 0 untuk ticker ini
            }
          }),
        );
        rows = enriched;
      }
      return rows.map((row) => ({ ...row, matchScore: computeMatchScore(row, criteria) }))
        .filter((r) => r.matchScore > 0)
        .sort((a, b) => b.matchScore - a.matchScore || a.ticker.localeCompare(b.ticker));
    };
    const where = buildWhereClause(criteria);
    // Phase 3: where SQL-native v2 bila kriteria dikenal — pre-filter server-side,
    // fallback client-side bila where 400/500 atau kriteria tak dikenal.
    if (where) {
      try {
        const rows = await this.request<V2Paged<V2ScreenerItem>>(
          `/companies/?where=${encodeURIComponent(where)}&limit=200`,
        );
        return await scoreRows(rows);
      } catch (error) {
        if (error instanceof SectorsApiError && error.code === 'BAD_REQUEST') {
          // fallback: ambil universe tanpa where
        } else {
          throw error;
        }
      }
    }
    const rows = await this.request<V2Paged<V2ScreenerItem>>(`/companies/?limit=200`);
    return scoreRows(rows);
  }

  // —— Market Researcher (Phase 1, addendum §24-A.2) ——
  async getDailyTransaction(ticker: string): Promise<DailyTransaction> {
    const symbol = normalizeTicker(ticker);
    const req = requirement('daily_transaction', symbol, { end: this.edate, start: this.sdate }, { kind: 'historical_range' });
    return this.cached(this.cache, req, () =>
      this.request<V2DailyRow[]>(
        `/daily/${encodeURIComponent(symbol)}/?start=${this.sdate}&end=${this.edate}`,
        symbol,
      ).then(toDailyTransaction),
    );
  }

  async getForeignFlow(ticker: string): Promise<ForeignFlow> {
    const symbol = normalizeTicker(ticker);
    const req = requirement('foreign_flow', symbol, { end: this.edate, start: this.sdate }, { kind: 'historical_range' });
    return this.cached(this.cache, req, () =>
      this.request<V2ForeignFlow>(
        `/foreign-flow/${encodeURIComponent(symbol)}/?start=${this.sdate}&end=${this.edate}`,
        symbol,
      ).then(toForeignFlow),
    );
  }

  // —— News Researcher (Phase 1, addendum §24-A.2) — newsCache TTL lebih pendek.
  async getNews(ticker: string): Promise<NewsArticle[]> {
    const symbol = normalizeTicker(ticker);
    const req = requirement('news', symbol, { limit: 20, symbols: symbol }, { kind: 'recent_snapshot' });
    return this.cached(this.newsCache, req, () =>
      this.request<V2Paged<V2NewsItem>>(`/news/?symbols=${encodeURIComponent(symbol)}&limit=20`, symbol).then((raw) =>
        toNewsArticles(raw, symbol),
      ),
    );
  }

  async getFilings(ticker: string): Promise<Filing[]> {
    const symbol = normalizeTicker(ticker);
    const req = requirement('filings', symbol, { limit: 10, symbol }, { kind: 'event_revalidation' });
    return this.cached(this.newsCache, req, () =>
      this.request<V2Paged<V2FilingItem>>(`/filings/?symbol=${encodeURIComponent(symbol)}&limit=10`, symbol).then(
        (raw) => toFilings(raw, symbol),
      ),
    );
  }

  /** Sentimen diturunkan (bukan endpoint v2): dari news tags + sign foreign-flow. */
  async getSentiment(ticker: string): Promise<Sentiment> {
    // getNews/getFilings memakai cache → umumnya tidak menambah call berbayar.
    const [news, foreign] = await Promise.all([this.getNews(ticker), this.getForeignFlow(ticker)]);
    return deriveSentiment(normalizeTicker(ticker), news, foreign);
  }

  /** Read-through cache: hit → langsung return; miss → fetch lalu simpan + metadata data-date. */
  private async cached<T>(cache: FileCache, req: SectorsCacheRequirement, fetcher: () => Promise<T>, metaFor?: (data: T) => CacheEntryMeta): Promise<T> {
    const cacheKey = cacheKeyFor(req);
    const entry = cache.getEntry<T>(cacheKey);
    const decision = evaluateCacheEntry(req, entry, {
      now: this.now(),
      ttlMs: this.cacheTtlMs,
      newsTtlMs: this.newsCacheTtlMs,
    });
    this.onCacheDecision?.(decision);
    if (decision.action === 'reuse') return entry!.data;
    const data = await fetcher();
    cache.set(cacheKey, data, {
      ...metaFor?.(data),
      cacheIdentity: cacheKey,
      schemaVersion: req.schemaVersion,
      adapterVersion: req.adapterVersion,
      source: 'sectors-api',
    });
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
