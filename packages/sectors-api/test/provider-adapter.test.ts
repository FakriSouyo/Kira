import { describe, expect, it, vi } from 'vitest';
import { FinancialDataError, type FinancialDataProvider } from '@harness/financial-data';
import {
  MockSectorsApi,
  SectorsApiError,
  SectorsFinancialDataProvider,
} from '../src/index';

describe('Sectors financial data provider adapter', () => {
  it('makes the deterministic Sectors mock satisfy the neutral consumer contract', async () => {
    const provider: FinancialDataProvider = new MockSectorsApi();

    await expect(provider.getCompanyReport('BBCA')).resolves.toMatchObject({ ticker: 'BBCA' });
    await expect(provider.getQuarterlyFinancials('BBCA')).resolves.toMatchObject({ ticker: 'BBCA' });
    await expect(provider.getDailyTransaction('BBCA')).resolves.toMatchObject({ ticker: 'BBCA' });
    await expect(provider.getForeignFlow('BBCA')).resolves.toMatchObject({ ticker: 'BBCA' });
    await expect(provider.getNews('BBCA')).resolves.toBeInstanceOf(Array);
    await expect(provider.getFilings('BBCA')).resolves.toBeInstanceOf(Array);
    await expect(provider.getSentiment('BBCA')).resolves.toMatchObject({ ticker: 'BBCA' });
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

    await expect(provider.getCompanyReport('BBRI')).resolves.toMatchObject({ ticker: 'BBRI' });
    await expect(provider.getQuarterlyFinancials('BBRI')).resolves.toMatchObject({ ticker: 'BBRI' });
    await expect(provider.getDailyTransaction('BBRI')).resolves.toMatchObject({ ticker: 'BBRI' });
    await expect(provider.getForeignFlow('BBRI')).resolves.toMatchObject({ ticker: 'BBRI' });
    await expect(provider.getNews('BBRI')).resolves.toBeInstanceOf(Array);
    await expect(provider.getFilings('BBRI')).resolves.toBeInstanceOf(Array);
    await expect(provider.getSentiment('BBRI')).resolves.toMatchObject({ ticker: 'BBRI' });
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
});
