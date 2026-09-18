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

/** Provider-neutral financial data operations used by deterministic consumers. */
export interface FinancialDataProvider {
  getCompanyReport(ticker: string): Promise<CompanyReport>;
  getQuarterlyFinancials(ticker: string): Promise<QuarterlyFinancials>;
  screen(criteria: string[]): Promise<ScreenerResult[]>;
  getDailyTransaction(ticker: string): Promise<DailyTransaction>;
  getForeignFlow(ticker: string): Promise<ForeignFlow>;
  getNews(ticker: string): Promise<NewsArticle[]>;
  getFilings(ticker: string): Promise<Filing[]>;
  getSentiment(ticker: string): Promise<Sentiment>;
}
