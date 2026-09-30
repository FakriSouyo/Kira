/** Provider-neutral financial data shapes consumed by research workflows. */

/** Company report — fundamental and valuation data. */
export interface CompanyReport {
  ticker: string;
  name?: string;
  sector?: string;
  asOf?: string;
  financials: {
    roe?: number;
    roa?: number;
    netMargin?: number;
    grossMargin?: number;
    debtToEquity?: number;
    currentRatio?: number;
    yoyQuarterRevenueGrowth?: number;
    yoyQuarterEarningsGrowth?: number;
  };
  valuation: {
    price?: number;
    pe?: number;
    pb?: number;
    dividendYield?: number;
  };
}

/** Quarterly financials — trend and growth data. */
export type QuarterlyGrowthMetric = 'revenueGrowthYoy' | 'netIncomeGrowthYoy';

export interface ProvenQuarterlyGrowthBasis {
  status: 'proven';
  method: 'same_quarter_prior_year';
  period: string;
  comparisonPeriod: string;
  periodType: 'single_quarter';
  unit: 'percent';
}

export interface UnprovenQuarterlyGrowthBasis {
  status: 'unproven';
  reason: 'COMPANY_REPORT_PERIOD_UNVERIFIED';
}

export type QuarterlyGrowthBasis = ProvenQuarterlyGrowthBasis | UnprovenQuarterlyGrowthBasis;

export type QuarterlyGrowthBasisByMetric = Partial<Record<QuarterlyGrowthMetric, QuarterlyGrowthBasis>>;

export interface QuarterlyFinancials {
  ticker: string;
  currency?: string;
  quarters: Array<{
    period: string;
    periodType?: 'single_quarter';
    revenue: number;
    netIncome: number;
    revenueGrowthYoy?: number;
    netIncomeGrowthYoy?: number;
    /** Optional proof metadata. Missing legacy metadata never implies comparability. */
    growthBasis?: QuarterlyGrowthBasisByMetric;
  }>;
  cumulativeYtd?: {
    periodLabel: string;
    revenueGrowthYoy?: number;
    netIncomeGrowthYoy?: number;
  };
}

/** One screener row before deterministic match scoring. */
export interface ScreenerRow {
  ticker: string;
  name?: string;
  roe?: number;
  revenueGrowthYoy?: number;
  netIncomeGrowthYoy?: number;
  pe?: number;
  pb?: number;
}

/** Screener row with deterministic match score. */
export type ScreenerResult = ScreenerRow & { matchScore: number };

/** Daily transaction and liquidity data. */
export interface DailyTransaction {
  ticker: string;
  asOf: string;
  window: string;
  avgValueBillion?: number;
  volumeRatio?: number;
  upDaysPct?: number;
  avgIntradayVolatilityPct?: number;
  liquidityBand?: 'high' | 'moderate' | 'low';
}

/** Foreign flow data. */
export interface ForeignFlow {
  ticker: string;
  asOf: string;
  window: string;
  netForeignPctOfCap?: number;
  netFlow?: 'buy' | 'sell' | 'neutral';
  netBuyDaysPct?: number;
}

/** A news article returned by a financial data provider. */
export interface NewsArticle {
  id: string;
  ticker: string;
  headline: string;
  url?: string;
  publishedAt: string;
  snippet: string;
  sentiment?: 'positive' | 'negative' | 'neutral';
  source?: string;
}

/** A regulatory filing. */
export interface Filing {
  id: string;
  ticker: string;
  type: string;
  title: string;
  filedAt: string;
  url?: string;
}

/** Derived or provider-supplied sentiment summary. */
export interface Sentiment {
  ticker: string;
  asOf: string;
  window: string;
  aggregate?: number;
  distribution?: { positive: number; negative: number; neutral: number };
  articleCount?: number;
}
