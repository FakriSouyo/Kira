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

const metadata = {
  providerId: 'test', source: 'test.company_report', origin: 'MOCK' as const,
  fetchedAt: null, dataAsOf: null, requestedAsOf: null, period: null, derivedFrom: [],
};

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
      async getCompanyReport() { return { data: report, metadata }; },
      async getQuarterlyFinancials() { return { data: quarterly, metadata: { ...metadata, source: 'test.quarterly_financials' } }; },
      async getDailyTransaction() { return { data: daily, metadata: { ...metadata, source: 'test.daily_transaction' } }; },
      async getForeignFlow() { return { data: foreign, metadata: { ...metadata, source: 'test.foreign_flow' } }; },
      async getNews() { return { data: news, metadata: { ...metadata, source: 'test.news' } }; },
      async getFilings() { return { data: filings, metadata: { ...metadata, source: 'test.filings' } }; },
      async getSentiment() { return { data: sentiment, metadata: { ...metadata, source: 'test.sentiment' } }; },
      async screen() { return screened; },
    };

    await expect(provider.getCompanyReport('BBCA')).resolves.toMatchObject({ data: report });
    await expect(provider.getQuarterlyFinancials('BBCA')).resolves.toMatchObject({ data: quarterly });
    await expect(provider.getDailyTransaction('BBCA')).resolves.toMatchObject({ data: daily });
    await expect(provider.getForeignFlow('BBCA')).resolves.toMatchObject({ data: foreign });
    await expect(provider.getNews('BBCA')).resolves.toMatchObject({ data: news });
    await expect(provider.getFilings('BBCA')).resolves.toMatchObject({ data: filings });
    await expect(provider.getSentiment('BBCA')).resolves.toMatchObject({ data: sentiment });
    await expect(provider.screen([])).resolves.toBe(screened);
  });
});
