import { describe, expect, it } from 'vitest';
import { FinancialDataError } from '../src/index';
import type {
  CompanyReport,
  DailyTransaction,
  Filing,
  FinancialDataProvider,
  ForeignFlow,
  NewsArticle,
  QuarterlyFinancials,
  ScreenerResult,
  Sentiment,
} from '../src/index';

describe('FinancialDataProvider contract', () => {
  it('exposes provider-neutral failures for composition error mapping', () => {
    const error = new FinancialDataError('NOT_FOUND', 'Ticker missing', 'Try another ticker');

    expect(error).toMatchObject({
      name: 'FinancialDataError',
      code: 'NOT_FOUND',
      message: 'Ticker missing',
      suggestion: 'Try another ticker',
    });
  });

  it('supports the existing financial data surface without a provider-specific interface', async () => {
    const report: CompanyReport = {
      ticker: 'BBCA',
      financials: {},
      valuation: {},
    };
    const quarterly: QuarterlyFinancials = { ticker: 'BBCA', quarters: [] };
    const daily: DailyTransaction = { ticker: 'BBCA', asOf: '', window: '0d' };
    const foreign: ForeignFlow = { ticker: 'BBCA', asOf: '', window: '0d' };
    const news: NewsArticle[] = [];
    const filings: Filing[] = [];
    const sentiment: Sentiment = { ticker: 'BBCA', asOf: '', window: '0d' };
    const screened: ScreenerResult[] = [];
    const provider: FinancialDataProvider = {
      async getCompanyReport() { return report; },
      async getQuarterlyFinancials() { return quarterly; },
      async getDailyTransaction() { return daily; },
      async getForeignFlow() { return foreign; },
      async getNews() { return news; },
      async getFilings() { return filings; },
      async getSentiment() { return sentiment; },
      async screen() { return screened; },
    };

    await expect(provider.getCompanyReport('BBCA')).resolves.toBe(report);
    await expect(provider.getQuarterlyFinancials('BBCA')).resolves.toBe(quarterly);
    await expect(provider.getDailyTransaction('BBCA')).resolves.toBe(daily);
    await expect(provider.getForeignFlow('BBCA')).resolves.toBe(foreign);
    await expect(provider.getNews('BBCA')).resolves.toBe(news);
    await expect(provider.getFilings('BBCA')).resolves.toBe(filings);
    await expect(provider.getSentiment('BBCA')).resolves.toBe(sentiment);
    await expect(provider.screen([])).resolves.toBe(screened);
  });
});
