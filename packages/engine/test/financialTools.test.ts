import { describe, expect, it, vi } from 'vitest';
import { ToolRuntime } from '@harness/tool-runtime';
import type {
  CompanyReport,
  DailyTransaction,
  Filing,
  FinancialDataProvider,
  FinancialDataResult,
  ForeignFlow,
  NewsArticle,
  QuarterlyFinancials,
  Sentiment,
  ScreenerResult,
} from '@harness/financial-data';
import { createFinancialTools } from '../src/tools/financial';

const metadata = {
  providerId: 'test',
  source: 'test.financial',
  origin: 'MOCK' as const,
  fetchedAt: null,
  dataAsOf: null,
  requestedAsOf: null,
  period: null,
  derivedFrom: [],
};

const report: CompanyReport = {
  ticker: 'BBCA',
  financials: { roe: 12.5 },
  valuation: { pe: 10.2 },
};
const quarterly: QuarterlyFinancials = {
  ticker: 'BBCA',
  quarters: [{ period: '2026-Q2', revenue: 100, netIncome: 20 }],
};
const daily: DailyTransaction = { ticker: 'BBCA', asOf: '2026-09-20', window: '30d' };
const foreign: ForeignFlow = { ticker: 'BBCA', asOf: '2026-09-20', window: '30d' };
const news: NewsArticle[] = [{
  id: 'n1', ticker: 'BBCA', headline: 'Headline', publishedAt: '2026-09-20', snippet: 'Snippet',
}];
const filings: Filing[] = [{
  id: 'f1', ticker: 'BBCA', type: 'annual', title: 'Annual report', filedAt: '2026-09-20',
}];
const sentiment: Sentiment = { ticker: 'BBCA', asOf: '2026-09-20', window: '30d', aggregate: 0.2 };
const screened: ScreenerResult[] = [{ ticker: 'BBCA', matchScore: 1 }];

function result<T>(data: T, source: string): FinancialDataResult<T> {
  return { data, metadata: { ...metadata, source } };
}

function provider(): FinancialDataProvider {
  return {
    getCompanyReport: vi.fn(async () => result(report, 'test.company_report')),
    getQuarterlyFinancials: vi.fn(async () => result(quarterly, 'test.quarterly_financials')),
    screen: vi.fn(async () => screened),
    getDailyTransaction: vi.fn(async () => result(daily, 'test.daily_transaction')),
    getForeignFlow: vi.fn(async () => result(foreign, 'test.foreign_flow')),
    getNews: vi.fn(async () => result(news, 'test.news')),
    getFilings: vi.fn(async () => result(filings, 'test.filings')),
    getSentiment: vi.fn(async () => result(sentiment, 'test.sentiment')),
  };
}

describe('financial tool adapters', () => {
  it('exposes all eight canonical operations with explicit stable IDs', async () => {
    const data = provider();
    const tools = createFinancialTools(data);
    const runtime = new ToolRuntime();

    expect(Object.values(tools).map(tool => tool.id)).toEqual([
      'financial.company-report',
      'financial.quarterly-financials',
      'financial.screen',
      'financial.daily-transaction',
      'financial.foreign-flow',
      'financial.news',
      'financial.filings',
      'financial.sentiment',
    ]);

    await expect(runtime.invoke(tools.companyReport, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(report, 'test.company_report') });
    await expect(runtime.invoke(tools.quarterlyFinancials, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(quarterly, 'test.quarterly_financials') });
    await expect(runtime.invoke(tools.screen, { criteria: ['roe > 10'] })).resolves.toMatchObject({ value: screened });
    await expect(runtime.invoke(tools.dailyTransaction, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(daily, 'test.daily_transaction') });
    await expect(runtime.invoke(tools.foreignFlow, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(foreign, 'test.foreign_flow') });
    await expect(runtime.invoke(tools.news, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(news, 'test.news') });
    await expect(runtime.invoke(tools.filings, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(filings, 'test.filings') });
    await expect(runtime.invoke(tools.sentiment, { ticker: 'BBCA' })).resolves.toMatchObject({ value: result(sentiment, 'test.sentiment') });

    expect(data.getCompanyReport).toHaveBeenCalledWith('BBCA');
    expect(data.getQuarterlyFinancials).toHaveBeenCalledWith('BBCA');
    expect(data.screen).toHaveBeenCalledWith(['roe > 10']);
    expect(data.getDailyTransaction).toHaveBeenCalledWith('BBCA');
    expect(data.getForeignFlow).toHaveBeenCalledWith('BBCA');
    expect(data.getNews).toHaveBeenCalledWith('BBCA');
    expect(data.getFilings).toHaveBeenCalledWith('BBCA');
    expect(data.getSentiment).toHaveBeenCalledWith('BBCA');
  });

  it('rejects malformed financial output at the typed tool boundary', async () => {
    const data = provider();
    vi.mocked(data.getCompanyReport).mockResolvedValue({
      data: { ticker: 'BBCA', financials: {} } as CompanyReport,
      metadata,
    });
    const runtime = new ToolRuntime();

    await expect(runtime.invoke(createFinancialTools(data).companyReport, { ticker: 'BBCA' }))
      .rejects.toMatchObject({ code: 'TOOL_OUTPUT_INVALID' });
  });

  it('preserves provider/domain error identity', async () => {
    const error = new Error('provider unavailable');
    const data = provider();
    vi.mocked(data.getNews).mockRejectedValue(error);

    await expect(new ToolRuntime().invoke(createFinancialTools(data).news, { ticker: 'BBCA' }))
      .rejects.toBe(error);
  });
});
