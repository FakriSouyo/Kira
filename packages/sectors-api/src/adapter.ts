import type { FinancialDataProvider } from '@harness/financial-data';
import type { SectorsApi } from './types';

/** Adapts the existing Sectors implementation to the neutral provider seam. */
export class SectorsFinancialDataProvider implements FinancialDataProvider {
  constructor(private readonly api: SectorsApi) {}

  getCompanyReport(ticker: string) { return this.api.getCompanyReport(ticker); }
  getQuarterlyFinancials(ticker: string) { return this.api.getQuarterlyFinancials(ticker); }
  screen(criteria: string[]) { return this.api.screen(criteria); }
  getDailyTransaction(ticker: string) { return this.api.getDailyTransaction(ticker); }
  getForeignFlow(ticker: string) { return this.api.getForeignFlow(ticker); }
  getNews(ticker: string) { return this.api.getNews(ticker); }
  getFilings(ticker: string) { return this.api.getFilings(ticker); }
  getSentiment(ticker: string) { return this.api.getSentiment(ticker); }
}
