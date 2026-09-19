import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FinancialDataError, type FinancialDataProvider } from '@harness/financial-data';
import {
  MockSectorsApi,
  SectorsApiError,
  SectorsClient,
  SectorsFinancialDataProvider,
} from '../src/index';

const V2_REPORT = {
  symbol: 'BBCA.JK',
  company_name: 'Bank Central Asia',
  overview: { sector: 'Financials' },
  valuation: { last_close_price: 9850, latest_close_date: '2025-01-10', forward_pe: 4.6, historical_valuation: [{ year: 2024, pb: 1.6, pe: 4.6 }] },
  financials: { historical_financials: [{ year: 2024, revenue: 300000, earnings: 105000, total_assets: 600000, total_equity: 500000 }] },
  dividend: { historical_dividends: { '2024': { total_yield: 0.031 } } },
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Sectors financial data provider adapter', () => {
  it('makes the deterministic Sectors mock satisfy the neutral consumer contract', async () => {
    const provider: FinancialDataProvider = new MockSectorsApi();

    await expect(provider.getCompanyReport('BBCA')).resolves.toMatchObject({ data: { ticker: 'BBCA' } });
    await expect(provider.getQuarterlyFinancials('BBCA')).resolves.toMatchObject({ data: { ticker: 'BBCA' } });
    await expect(provider.getDailyTransaction('BBCA')).resolves.toMatchObject({ data: { ticker: 'BBCA' } });
    await expect(provider.getForeignFlow('BBCA')).resolves.toMatchObject({ data: { ticker: 'BBCA' } });
    await expect(provider.getNews('BBCA')).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(provider.getFilings('BBCA')).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(provider.getSentiment('BBCA')).resolves.toMatchObject({ data: { ticker: 'BBCA' } });
    await expect(provider.screen(['profitable'])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'BBCA', matchScore: 50 }),
    ]));
  });

  it('delegates the same financial operations through the Sectors-backed adapter', async () => {
    const api = new MockSectorsApi();
    const methods: Array<keyof FinancialDataProvider> = [
      'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
      'getForeignFlow', 'getNews', 'getFilings', 'getSentiment', 'screen',
    ];
    const spies = methods.map(method => vi.spyOn(api, method));
    const provider: FinancialDataProvider = new SectorsFinancialDataProvider(api);

    await expect(provider.getCompanyReport('BBRI')).resolves.toMatchObject({ data: { ticker: 'BBRI' } });
    await expect(provider.getQuarterlyFinancials('BBRI')).resolves.toMatchObject({ data: { ticker: 'BBRI' } });
    await expect(provider.getDailyTransaction('BBRI')).resolves.toMatchObject({ data: { ticker: 'BBRI' } });
    await expect(provider.getForeignFlow('BBRI')).resolves.toMatchObject({ data: { ticker: 'BBRI' } });
    await expect(provider.getNews('BBRI')).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(provider.getFilings('BBRI')).resolves.toMatchObject({ data: expect.any(Array) });
    await expect(provider.getSentiment('BBRI')).resolves.toMatchObject({ data: { ticker: 'BBRI' } });
    await expect(provider.screen(['growing'])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ ticker: 'BBRI', matchScore: 50 }),
    ]));
    expect(spies.map(spy => spy.mock.calls.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('keeps Sectors errors compatible with the neutral composition error boundary', () => {
    const error = new SectorsApiError('NOT_FOUND', 'Ticker missing', 'Try another ticker');

    expect(error).toBeInstanceOf(FinancialDataError);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('surfaces existing cache metadata without adding a provider call', async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'finharness-provider-envelope-'));
    try {
      let calls = 0;
      const api = new SectorsClient({
        cacheDir,
        now: () => new Date('2026-09-19T00:00:00.000Z'),
        fetchImpl: (async () => { calls += 1; return response(V2_REPORT); }) as typeof fetch,
      });
      const provider: FinancialDataProvider = new SectorsFinancialDataProvider(api);

      const first = await provider.getCompanyReport('BBCA');
      const second = await provider.getCompanyReport('BBCA');

      expect(first.data.ticker).toBe('BBCA');
      expect(first.metadata).toMatchObject({
        providerId: 'sectors', source: 'sectors.company_report', origin: 'PROVIDER',
        fetchedAt: expect.any(String), dataAsOf: '2025-01-10', requestedAsOf: null,
      });
      expect(second.metadata.origin).toBe('CACHE');
      expect(second.metadata.fetchedAt).toBe(first.metadata.fetchedAt);
      expect(calls).toBe(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
