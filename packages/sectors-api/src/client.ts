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
  /** Default https://api.sectors.app/v1 */
  baseUrl?: string;
  /** Default 30_000 ms. */
  timeoutMs?: number;
  /** Default 24 jam. */
  cacheTtlHours?: number;
  /** TTL khusus News (news/filings/sentiment) — semi-volatil. Default 1 jam (addendum §24-A.6). */
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
    error instanceof DOMException && error.name === 'AbortError' ||
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
      'Check SECTORS_API_KEY in .env or ~/.finharness/config.json, or use --mock-sectors',
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

/**
 * Client HTTP Sectors API (addendum Task 6).
 * Kontrak endpoint terpusat di sini — satu tempat bila API berubah.
 * Response company report & quarterly financials di-cache di file (TTL 24h);
 * screener tidak di-cache (kriteria bervariasi per panggilan).
 */
export class SectorsClient implements SectorsApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cache: FileCache;
  private readonly newsCache: FileCache;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SectorsApiOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.SECTORS_API_KEY ?? '';
    this.baseUrl = (options.baseUrl ?? 'https://api.sectors.app/v1').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const homeDir = options.homeDir ?? process.env.FINHARNESS_HOME ?? join(homedir(), '.finharness');
    const cacheDir = options.cacheDir ?? join(homeDir, 'cache', 'sectors_api');
    // Fundamental & Market memakai TTL default (24 jam). News/filings/sentiment
    // memakai TTL lebih pendek (default 1 jam) karena semi-volatil.
    this.cache = new FileCache(cacheDir, (options.cacheTtlHours ?? 24) * 3_600_000);
    this.newsCache = new FileCache(cacheDir, (options.newsCacheTtlHours ?? 1) * 3_600_000);
  }

  async getCompanyReport(ticker: string): Promise<CompanyReport> {
    return this.cached(this.cache, 'company_report', ticker, () =>
      this.request<CompanyReport>(`/companies/${encodeURIComponent(ticker)}/report`, ticker),
    );
  }

  async getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials> {
    return this.cached(this.cache, 'quarterly_financials', ticker, () =>
      this.request<QuarterlyFinancials>(`/companies/${encodeURIComponent(ticker)}/financials/quarterly`, ticker),
    );
  }

  async screen(criteria: string[]): Promise<ScreenerResult[]> {
    const query = criteria.length > 0 ? `?criteria=${encodeURIComponent(criteria.join(','))}` : '';
    const rows = await this.request<ScreenerRow[]>(`/screener${query}`);
    return rows
      .map((row) => ({ ...row, matchScore: computeMatchScore(row, criteria) }))
      .sort((a, b) => b.matchScore - a.matchScore || a.ticker.localeCompare(b.ticker));
  }

  // —— Market Researcher (Phase 1, addendum §24-A.2) ——
  async getDailyTransaction(ticker: string): Promise<DailyTransaction> {
    return this.cached(this.cache, 'daily_transaction', ticker, () =>
      this.request<DailyTransaction>(`/companies/${encodeURIComponent(ticker)}/daily-transaction`, ticker),
    );
  }

  async getForeignFlow(ticker: string): Promise<ForeignFlow> {
    return this.cached(this.cache, 'foreign_flow', ticker, () =>
      this.request<ForeignFlow>(`/companies/${encodeURIComponent(ticker)}/foreign-flow`, ticker),
    );
  }

  // —— News Researcher (Phase 1, addendum §24-A.2) — newsCache TTL lebih pendek.
  async getNews(ticker: string): Promise<NewsArticle[]> {
    return this.cached(this.newsCache, 'news', ticker, () =>
      this.request<NewsArticle[]>(`/companies/${encodeURIComponent(ticker)}/news`, ticker),
    );
  }

  async getFilings(ticker: string): Promise<Filing[]> {
    return this.cached(this.newsCache, 'filings', ticker, () =>
      this.request<Filing[]>(`/companies/${encodeURIComponent(ticker)}/filings`, ticker),
    );
  }

  async getSentiment(ticker: string): Promise<Sentiment> {
    return this.cached(this.newsCache, 'sentiment', ticker, () =>
      this.request<Sentiment>(`/companies/${encodeURIComponent(ticker)}/sentiment`, ticker),
    );
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
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
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
