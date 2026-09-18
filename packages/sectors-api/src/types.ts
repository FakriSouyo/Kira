import type { FinancialDataProvider } from '@harness/financial-data';

export type {
  CompanyReport,
  DailyTransaction,
  Filing,
  ForeignFlow,
  NewsArticle,
  QuarterlyFinancials,
  ScreenerResult,
  ScreenerRow,
  Sentiment,
} from '@harness/financial-data';

/** Compatibility name for the pre-PR M Sectors-facing contract. */
export type SectorsApi = FinancialDataProvider;

/** Provider provenance identifiers retained for evidence auditability. */
export const SECTORS_SOURCES = {
  companyReport: 'sectors.company_report',
  quarterlyFinancials: 'sectors.quarterly_financials',
  dailyTransaction: 'sectors.daily_transaction',
  foreignFlow: 'sectors.foreign_flow',
  news: 'sectors.news',
  filings: 'sectors.filings',
  sentiment: 'sectors.sentiment',
} as const;
