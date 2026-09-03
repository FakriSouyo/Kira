import { computeMatchScore, SectorsApiError } from './client';
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

/**
 * Data fiks deterministik untuk development offline
 * (flag `--mock-sectors` / FINHARNESS_MOCK_SECTORS, addendum §12/§22).
 * Angka dirancang konsisten supaya rubrik Judge (health/growth/valuation)
 * bisa dievaluasi penuh tanpa API key.
 */

interface Fixture {
  report: CompanyReport;
  financials: QuarterlyFinancials;
}

const UNIVERSE: Record<string, Fixture> = {
  BBCA: {
    report: {
      ticker: 'BBCA',
      name: 'Bank Central Asia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 23.1, roa: 3.4, netMargin: 35.2, debtToEquity: 9.8 },
      valuation: { price: 9850, pe: 4.6, pb: 1.6, dividendYield: 3.1 },
    },
    financials: {
      ticker: 'BBCA',
      currency: 'IDR',
      quarters: [
        { period: '2024-Q4', revenue: 10_150, netIncome: 3_980, revenueGrowthYoy: 9.8, netIncomeGrowthYoy: 8.7 },
        { period: '2024-Q3', revenue: 9_720, netIncome: 3_790, revenueGrowthYoy: 9.1, netIncomeGrowthYoy: 7.9 },
        { period: '2024-Q2', revenue: 9_410, netIncome: 3_650, revenueGrowthYoy: 8.6, netIncomeGrowthYoy: 7.4 },
        { period: '2024-Q1', revenue: 9_200, netIncome: 3_540, revenueGrowthYoy: 8.2, netIncomeGrowthYoy: 6.9 },
      ],
    },
  },
  BBRI: {
    report: {
      ticker: 'BBRI',
      name: 'Bank Rakyat Indonesia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 20.3, roa: 3.0, netMargin: 32.0, debtToEquity: 8.9 },
      valuation: { price: 4620, pe: 4.2, pb: 1.4, dividendYield: 4.0 },
    },
    financials: {
      ticker: 'BBRI',
      currency: 'IDR',
      quarters: [
        { period: '2024-Q4', revenue: 8_900, netIncome: 2_850, revenueGrowthYoy: 7.4, netIncomeGrowthYoy: 7.2 },
        { period: '2024-Q3', revenue: 8_540, netIncome: 2_730, revenueGrowthYoy: 6.9, netIncomeGrowthYoy: 6.6 },
        { period: '2024-Q2', revenue: 8_310, netIncome: 2_640, revenueGrowthYoy: 6.4, netIncomeGrowthYoy: 6.1 },
        { period: '2024-Q1', revenue: 8_120, netIncome: 2_560, revenueGrowthYoy: 5.8, netIncomeGrowthYoy: 5.5 },
      ],
    },
  },
  BMRI: {
    report: {
      ticker: 'BMRI',
      name: 'Bank Mandiri',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 18.5, roa: 2.6, netMargin: 30.5, debtToEquity: 8.2 },
      valuation: { price: 6150, pe: 4.8, pb: 1.3, dividendYield: 2.8 },
    },
    financials: {
      ticker: 'BMRI',
      currency: 'IDR',
      quarters: [
        { period: '2024-Q4', revenue: 7_800, netIncome: 2_380, revenueGrowthYoy: 6.8, netIncomeGrowthYoy: 6.1 },
        { period: '2024-Q3', revenue: 7_520, netIncome: 2_290, revenueGrowthYoy: 6.2, netIncomeGrowthYoy: 5.7 },
        { period: '2024-Q2', revenue: 7_310, netIncome: 2_200, revenueGrowthYoy: 5.6, netIncomeGrowthYoy: 5.2 },
        { period: '2024-Q1', revenue: 7_150, netIncome: 2_120, revenueGrowthYoy: 5.1, netIncomeGrowthYoy: 4.8 },
      ],
    },
  },
  BBNI: {
    report: {
      ticker: 'BBNI',
      name: 'Bank Negara Indonesia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 14.2, roa: 1.8, netMargin: 26.4, debtToEquity: 7.6 },
      valuation: { price: 4180, pe: 4.0, pb: 1.1, dividendYield: 3.4 },
    },
    financials: {
      ticker: 'BBNI',
      currency: 'IDR',
      quarters: [
        { period: '2024-Q4', revenue: 5_400, netIncome: 1_420, revenueGrowthYoy: 4.6, netIncomeGrowthYoy: 4.1 },
        { period: '2024-Q3', revenue: 5_260, netIncome: 1_360, revenueGrowthYoy: 4.2, netIncomeGrowthYoy: 3.8 },
        { period: '2024-Q2', revenue: 5_140, netIncome: 1_310, revenueGrowthYoy: 3.9, netIncomeGrowthYoy: 3.4 },
        { period: '2024-Q1', revenue: 5_050, netIncome: 1_270, revenueGrowthYoy: 3.5, netIncomeGrowthYoy: 3.0 },
      ],
    },
  },
  BJTM: {
    report: {
      ticker: 'BJTM',
      name: 'Bank JP Morgan Indonesia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 12.1, roa: 1.5, netMargin: 24.8, debtToEquity: 7.1 },
      valuation: { price: 1320, pe: 3.6, pb: 0.9, dividendYield: 1.9 },
    },
    financials: {
      ticker: 'BJTM',
      currency: 'IDR',
      quarters: [
        { period: '2024-Q4', revenue: 3_100, netIncome: 770, revenueGrowthYoy: 2.4, netIncomeGrowthYoy: 1.8 },
        { period: '2024-Q3', revenue: 3_050, netIncome: 755, revenueGrowthYoy: 2.1, netIncomeGrowthYoy: 1.5 },
        { period: '2024-Q2', revenue: 3_010, netIncome: 742, revenueGrowthYoy: 1.7, netIncomeGrowthYoy: 1.2 },
        { period: '2024-Q1', revenue: 2_980, netIncome: 731, revenueGrowthYoy: 1.4, netIncomeGrowthYoy: 0.9 },
      ],
    },
  },
};

const SCREENER_ROWS: ScreenerRow[] = Object.entries(UNIVERSE).map(([ticker, fx]) => ({
  ticker,
  name: fx.report.name,
  roe: fx.report.financials.roe,
  revenueGrowthYoy: fx.financials.quarters[0]?.revenueGrowthYoy,
  netIncomeGrowthYoy: fx.financials.quarters[0]?.netIncomeGrowthYoy,
  pe: fx.report.valuation.pe,
  pb: fx.report.valuation.pb,
}));

// ─────────────────────────────────────────────────────────────────────────────
// Fixture Market & News (addendum §24-A) — deterministik.
// BBCA: likuid tinggi, foreign net buy, sentimen positif, filing bersih.
// BJTM: likuiditas rendah, net sell, sentimen negatif — untuk membuktikan
// rubrik `marketMomentum` & `risk` bisa bernilai beda antar ticker.
// ─────────────────────────────────────────────────────────────────────────────
interface MarketNewsFixture {
  daily: DailyTransaction;
  foreign: ForeignFlow;
  news: NewsArticle[];
  filings: Filing[];
  sentiment: Sentiment;
}

const MARKET_NEWS: Record<string, MarketNewsFixture> = {
  BBCA: {
    daily: {
      ticker: 'BBCA',
      asOf: '2025-01-15T00:00:00Z',
      window: '30d',
      avgValueBillion: 890,
      volumeRatio: 1.3,
      upDaysPct: 63,
      avgIntradayVolatilityPct: 1.2,
      liquidityBand: 'high',
    },
    foreign: { ticker: 'BBCA', asOf: '2025-01-15T00:00:00Z', window: '30d', netForeignPctOfCap: 0.8, netFlow: 'buy', netBuyDaysPct: 61 },
    news: [
      { id: 'n-1', ticker: 'BBCA', headline: 'BCA reports solid Q4 net income', publishedAt: '2025-01-10T02:00:00Z', snippet: 'Net income growth beats estimate.', sentiment: 'positive', source: 'Reuters' },
      { id: 'n-2', ticker: 'BBCA', headline: 'Foreign investors raise BCA holdings', publishedAt: '2025-01-12T05:00:00Z', snippet: 'Net foreign flows turned positive.', sentiment: 'positive', source: 'Bloomberg' },
    ],
    filings: [{ id: 'f-1', ticker: 'BBCA', type: 'annual_report', title: 'Annual Report 2024', filedAt: '2025-03-01T00:00:00Z' }],
    sentiment: { ticker: 'BBCA', asOf: '2025-01-15T00:00:00Z', window: '30d', aggregate: 0.7, distribution: { positive: 0.7, negative: 0.1, neutral: 0.2 }, articleCount: 20 },
  },
  BBRI: {
    daily: { ticker: 'BBRI', asOf: '2025-01-15T00:00:00Z', window: '30d', avgValueBillion: 620, volumeRatio: 1.1, upDaysPct: 55, avgIntradayVolatilityPct: 1.5, liquidityBand: 'moderate' },
    foreign: { ticker: 'BBRI', asOf: '2025-01-15T00:00:00Z', window: '30d', netForeignPctOfCap: 0.2, netFlow: 'neutral', netBuyDaysPct: 51 },
    news: [{ id: 'n-1', ticker: 'BBRI', headline: 'BRI lending growth steady', publishedAt: '2025-01-08T02:00:00Z', snippet: 'Loan growth in line with guidance.', sentiment: 'neutral', source: 'Reuters' }],
    filings: [{ id: 'f-1', ticker: 'BBRI', type: 'disclosure', title: 'Disclosure of shareholding', filedAt: '2025-02-10T00:00:00Z' }],
    sentiment: { ticker: 'BBRI', asOf: '2025-01-15T00:00:00Z', window: '30d', aggregate: 0.2, distribution: { positive: 0.4, negative: 0.2, neutral: 0.4 }, articleCount: 15 },
  },
  BMRI: {
    daily: { ticker: 'BMRI', asOf: '2025-01-15T00:00:00Z', window: '30d', avgValueBillion: 510, volumeRatio: 1.0, upDaysPct: 50, avgIntradayVolatilityPct: 1.6, liquidityBand: 'moderate' },
    foreign: { ticker: 'BMRI', asOf: '2025-01-15T00:00:00Z', window: '30d', netForeignPctOfCap: 0.0, netFlow: 'neutral', netBuyDaysPct: 50 },
    news: [],
    filings: [],
    sentiment: { ticker: 'BMRI', asOf: '2025-01-15T00:00:00Z', window: '30d', aggregate: 0.0, distribution: { positive: 0.35, negative: 0.3, neutral: 0.35 }, articleCount: 8 },
  },
  BBNI: {
    daily: { ticker: 'BBNI', asOf: '2025-01-15T00:00:00Z', window: '30d', avgValueBillion: 380, volumeRatio: 0.9, upDaysPct: 44, avgIntradayVolatilityPct: 1.9, liquidityBand: 'moderate' },
    foreign: { ticker: 'BBNI', asOf: '2025-01-15T00:00:00Z', window: '30d', netForeignPctOfCap: -0.2, netFlow: 'sell', netBuyDaysPct: 43 },
    news: [{ id: 'n-1', ticker: 'BBNI', headline: 'BNI cost base under pressure', publishedAt: '2025-01-09T03:00:00Z', snippet: 'Cost-to-income ratio ticked up.', sentiment: 'negative', source: 'Reuters' }],
    filings: [],
    sentiment: { ticker: 'BBNI', asOf: '2025-01-15T00:00:00Z', window: '30d', aggregate: -0.1, distribution: { positive: 0.3, negative: 0.35, neutral: 0.35 }, articleCount: 10 },
  },
  BJTM: {
    daily: { ticker: 'BJTM', asOf: '2025-01-15T00:00:00Z', window: '30d', avgValueBillion: 95, volumeRatio: 0.6, upDaysPct: 33, avgIntradayVolatilityPct: 2.4, liquidityBand: 'low' },
    foreign: { ticker: 'BJTM', asOf: '2025-01-15T00:00:00Z', window: '30d', netForeignPctOfCap: -0.5, netFlow: 'sell', netBuyDaysPct: 35 },
    news: [{ id: 'n-1', ticker: 'BJTM', headline: 'BJTM liquidity thins; sentiment negative', publishedAt: '2025-01-11T04:00:00Z', snippet: 'Thin trading continues.', sentiment: 'negative', source: 'Reuters' }],
    filings: [],
    sentiment: { ticker: 'BJTM', asOf: '2025-01-15T00:00:00Z', window: '30d', aggregate: -0.4, distribution: { positive: 0.2, negative: 0.5, neutral: 0.3 }, articleCount: 6 },
  },
};

/**
 * Implementasi SectorsApi offline (addendum §12 mock_mode).
 * Ticker tak dikenal ⇒ NOT_FOUND dengan saran yang sama dengan client asli,
 * sehingga jalur error workflow tetap teruji.
 */
export class MockSectorsApi implements SectorsApi {
  async getCompanyReport(ticker: string): Promise<CompanyReport> {
    const fx = UNIVERSE[ticker.toUpperCase()];
    if (!fx) {
      throw new SectorsApiError(
        'NOT_FOUND',
        `Ticker "${ticker}" not found in Sectors API`,
        'Try: /judge BBCA (or other valid ticker)',
      );
    }
    return fx.report;
  }

  async getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials> {
    const fx = UNIVERSE[ticker.toUpperCase()];
    if (!fx) {
      throw new SectorsApiError(
        'NOT_FOUND',
        `Ticker "${ticker}" not found in Sectors API`,
        'Try: /judge BBCA (or other valid ticker)',
      );
    }
    return fx.financials;
  }

  async screen(criteria: string[]): Promise<ScreenerResult[]> {
    return SCREENER_ROWS.map((row) => ({ ...row, matchScore: computeMatchScore(row, criteria) })).sort(
      (a, b) => b.matchScore - a.matchScore || a.ticker.localeCompare(b.ticker),
    );
  }

  // —— Market & News (Phase 1, addendum §24-A) — konsisten NOT_FOUND dgn client asli.

  private marketOrThrow(ticker: string): MarketNewsFixture {
    const fx = MARKET_NEWS[ticker.toUpperCase()];
    if (!fx) {
      throw new SectorsApiError(
        'NOT_FOUND',
        `Ticker "${ticker}" not found in Sectors API`,
        'Try: /judge BBCA (or other valid ticker)',
      );
    }
    return fx;
  }

  async getDailyTransaction(ticker: string): Promise<DailyTransaction> {
    return this.marketOrThrow(ticker).daily;
  }

  async getForeignFlow(ticker: string): Promise<ForeignFlow> {
    return this.marketOrThrow(ticker).foreign;
  }

  async getNews(ticker: string): Promise<NewsArticle[]> {
    return this.marketOrThrow(ticker).news;
  }

  async getFilings(ticker: string): Promise<Filing[]> {
    return this.marketOrThrow(ticker).filings;
  }

  async getSentiment(ticker: string): Promise<Sentiment> {
    return this.marketOrThrow(ticker).sentiment;
  }
}
