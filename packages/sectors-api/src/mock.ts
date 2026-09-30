import { computeMatchScore, SectorsApiError } from './client';
import type { FinancialDataMetadata, FinancialDataResult, FinancialObservationKind } from '@harness/financial-data';
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

function fixtureQuarter(
  period: string,
  revenue: number,
  netIncome: number,
  revenueGrowthYoy: number,
  netIncomeGrowthYoy: number,
): QuarterlyFinancials['quarters'][number] {
  const [year, quarter] = period.split('-');
  const comparisonPeriod = `${Number(year) - 1}-${quarter}`;
  const basis = {
    status: 'proven' as const,
    method: 'same_quarter_prior_year' as const,
    period,
    comparisonPeriod,
    periodType: 'single_quarter' as const,
    unit: 'percent' as const,
  };
  return {
    period,
    periodType: 'single_quarter',
    revenue,
    netIncome,
    revenueGrowthYoy,
    netIncomeGrowthYoy,
    growthBasis: { revenueGrowthYoy: basis, netIncomeGrowthYoy: basis },
  };
}

const UNIVERSE: Record<string, Fixture> = {
  BBCA: {
    report: {
      ticker: 'BBCA',
      name: 'Bank Central Asia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 23.1, roa: 3.4, netMargin: 35.2, debtToEquity: 9.8, yoyQuarterRevenueGrowth: 9.8, yoyQuarterEarningsGrowth: 8.7 },
      valuation: { price: 9850, pe: 4.6, pb: 1.6, dividendYield: 3.1 },
    },
    financials: {
      ticker: 'BBCA',
      currency: 'IDR',
      quarters: [
        fixtureQuarter('2024-Q4', 10_150, 3_980, 9.8, 8.7),
        fixtureQuarter('2024-Q3', 9_720, 3_790, 9.1, 7.9),
        fixtureQuarter('2024-Q2', 9_410, 3_650, 8.6, 7.4),
        fixtureQuarter('2024-Q1', 9_200, 3_540, 8.2, 6.9),
      ],
    },
  },
  BBRI: {
    report: {
      ticker: 'BBRI',
      name: 'Bank Rakyat Indonesia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 20.3, roa: 3.0, netMargin: 32.0, debtToEquity: 8.9, yoyQuarterRevenueGrowth: 7.4, yoyQuarterEarningsGrowth: 7.2 },
      valuation: { price: 4620, pe: 4.2, pb: 1.4, dividendYield: 4.0 },
    },
    financials: {
      ticker: 'BBRI',
      currency: 'IDR',
      quarters: [
        fixtureQuarter('2024-Q4', 8_900, 2_850, 7.4, 7.2),
        fixtureQuarter('2024-Q3', 8_540, 2_730, 6.9, 6.6),
        fixtureQuarter('2024-Q2', 8_310, 2_640, 6.4, 6.1),
        fixtureQuarter('2024-Q1', 8_120, 2_560, 5.8, 5.5),
      ],
    },
  },
  BMRI: {
    report: {
      ticker: 'BMRI',
      name: 'Bank Mandiri',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 18.5, roa: 2.6, netMargin: 30.5, debtToEquity: 8.2, yoyQuarterRevenueGrowth: 6.8, yoyQuarterEarningsGrowth: 6.1 },
      valuation: { price: 6150, pe: 4.8, pb: 1.3, dividendYield: 2.8 },
    },
    financials: {
      ticker: 'BMRI',
      currency: 'IDR',
      quarters: [
        fixtureQuarter('2024-Q4', 7_800, 2_380, 6.8, 6.1),
        fixtureQuarter('2024-Q3', 7_520, 2_290, 6.2, 5.7),
        fixtureQuarter('2024-Q2', 7_310, 2_200, 5.6, 5.2),
        fixtureQuarter('2024-Q1', 7_150, 2_120, 5.1, 4.8),
      ],
    },
  },
  BBNI: {
    report: {
      ticker: 'BBNI',
      name: 'Bank Negara Indonesia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 14.2, roa: 1.8, netMargin: 26.4, debtToEquity: 7.6, yoyQuarterRevenueGrowth: 4.6, yoyQuarterEarningsGrowth: 4.1 },
      valuation: { price: 4180, pe: 4.0, pb: 1.1, dividendYield: 3.4 },
    },
    financials: {
      ticker: 'BBNI',
      currency: 'IDR',
      quarters: [
        fixtureQuarter('2024-Q4', 5_400, 1_420, 4.6, 4.1),
        fixtureQuarter('2024-Q3', 5_260, 1_360, 4.2, 3.8),
        fixtureQuarter('2024-Q2', 5_140, 1_310, 3.9, 3.4),
        fixtureQuarter('2024-Q1', 5_050, 1_270, 3.5, 3.0),
      ],
    },
  },
  BJTM: {
    report: {
      ticker: 'BJTM',
      name: 'Bank JP Morgan Indonesia',
      sector: 'Banking',
      asOf: '2024-12-31',
      financials: { roe: 12.1, roa: 1.5, netMargin: 24.8, debtToEquity: 7.1, yoyQuarterRevenueGrowth: 2.4, yoyQuarterEarningsGrowth: 1.8 },
      valuation: { price: 1320, pe: 3.6, pb: 0.9, dividendYield: 1.9 },
    },
    financials: {
      ticker: 'BJTM',
      currency: 'IDR',
      quarters: [
        fixtureQuarter('2024-Q4', 3_100, 770, 2.4, 1.8),
        fixtureQuarter('2024-Q3', 3_050, 755, 2.1, 1.5),
        fixtureQuarter('2024-Q2', 3_010, 742, 1.7, 1.2),
        fixtureQuarter('2024-Q1', 2_980, 731, 1.4, 0.9),
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
  private result<K extends FinancialObservationKind, T>(kind: K, data: T, derivedFrom: FinancialObservationKind[] = []): FinancialDataResult<T> {
    const record = data as { asOf?: string; quarters?: Array<{ period?: string }> };
    const metadata: FinancialDataMetadata = {
      providerId: 'sectors',
      source: `sectors.${kind}`,
      origin: 'MOCK',
      fetchedAt: null,
      dataAsOf: record.asOf ?? null,
      requestedAsOf: null,
      period: record.quarters?.[0]?.period ?? null,
      derivedFrom,
    };
    return { data, metadata };
  }

  async getCompanyReport(ticker: string): Promise<FinancialDataResult<CompanyReport>> {
    const fx = UNIVERSE[ticker.toUpperCase()];
    if (!fx) {
      throw new SectorsApiError(
        'NOT_FOUND',
        `Ticker "${ticker}" not found in Sectors API`,
        'Try: /judge BBCA (or other valid ticker)',
      );
    }
    return this.result('company_report', fx.report);
  }

  async getQuarterlyFinancials(ticker: string): Promise<FinancialDataResult<QuarterlyFinancials>> {
    const fx = UNIVERSE[ticker.toUpperCase()];
    if (!fx) {
      throw new SectorsApiError(
        'NOT_FOUND',
        `Ticker "${ticker}" not found in Sectors API`,
        'Try: /judge BBCA (or other valid ticker)',
      );
    }
    return this.result('quarterly_financials', fx.financials);
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

  async getDailyTransaction(ticker: string): Promise<FinancialDataResult<DailyTransaction>> {
    return this.result('daily_transaction', this.marketOrThrow(ticker).daily);
  }

  async getForeignFlow(ticker: string): Promise<FinancialDataResult<ForeignFlow>> {
    return this.result('foreign_flow', this.marketOrThrow(ticker).foreign);
  }

  async getNews(ticker: string): Promise<FinancialDataResult<NewsArticle[]>> {
    return this.result('news', this.marketOrThrow(ticker).news);
  }

  async getFilings(ticker: string): Promise<FinancialDataResult<Filing[]>> {
    return this.result('filings', this.marketOrThrow(ticker).filings);
  }

  async getSentiment(ticker: string): Promise<FinancialDataResult<Sentiment>> {
    return this.result('sentiment', this.marketOrThrow(ticker).sentiment);
  }
}
