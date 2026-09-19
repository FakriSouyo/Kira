import type {
  CompanyReport,
  DailyTransaction,
  Filing,
  ForeignFlow,
  NewsArticle,
  QuarterlyFinancials,
  ScreenerResult,
  Sentiment,
} from './types';
import type { FinancialObservationKind } from './snapshot';

export type FinancialDataOrigin = 'PROVIDER' | 'CACHE' | 'MOCK' | 'DERIVED';

export interface FinancialDataMetadata {
  providerId: string;
  source: string;
  origin: FinancialDataOrigin;
  fetchedAt: string | null;
  dataAsOf: string | null;
  requestedAsOf: string | null;
  period: string | null;
  derivedFrom: FinancialObservationKind[];
}

export interface FinancialDataResult<T> {
  data: T;
  metadata: FinancialDataMetadata;
}

/** Provider-neutral financial data operations used by deterministic consumers. */
export interface FinancialDataProvider {
  getCompanyReport(ticker: string): Promise<FinancialDataResult<CompanyReport>>;
  getQuarterlyFinancials(ticker: string): Promise<FinancialDataResult<QuarterlyFinancials>>;
  screen(criteria: string[]): Promise<ScreenerResult[]>;
  getDailyTransaction(ticker: string): Promise<FinancialDataResult<DailyTransaction>>;
  getForeignFlow(ticker: string): Promise<FinancialDataResult<ForeignFlow>>;
  getNews(ticker: string): Promise<FinancialDataResult<NewsArticle[]>>;
  getFilings(ticker: string): Promise<FinancialDataResult<Filing[]>>;
  getSentiment(ticker: string): Promise<FinancialDataResult<Sentiment>>;
}
