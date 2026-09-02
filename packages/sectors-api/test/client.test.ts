import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeMatchScore, MockSectorsApi, SectorsApiError, SectorsClient } from '../src/index';

const REPORT = {
  ticker: 'BBCA',
  name: 'Bank Central Asia',
  financials: { roe: 23.1, roa: 3.4 },
  valuation: { pe: 4.6, pb: 1.6 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SectorsClient', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'finharness-sectors-cache-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetches company report and returns parsed data', async () => {
    const calls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return jsonResponse(REPORT);
      }) as typeof fetch,
    });

    const report = await client.getCompanyReport('BBCA');
    expect(report.ticker).toBe('BBCA');
    expect(report.financials.roe).toBe(23.1);
    expect(calls).toEqual(['https://api.sectors.app/v1/companies/BBCA/report']);
  });

  it('uses file cache on second call (no second API hit)', async () => {
    let hits = 0;
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => {
        hits += 1;
        return jsonResponse(REPORT);
      }) as typeof fetch,
    });

    const first = await client.getCompanyReport('BBCA');
    const second = await client.getCompanyReport('BBCA');
    expect(first).toEqual(second);
    expect(hits).toBe(1);
  });

  it('maps 404 to NOT_FOUND with ticker in message', async () => {
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => jsonResponse({ error: 'not found' }, 404)) as typeof fetch,
    });

    const error = await client.getCompanyReport('XYZ').catch((e) => e);
    expect(error).toBeInstanceOf(SectorsApiError);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('XYZ');
  });

  it('maps 429 to RATE_LIMIT', async () => {
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => jsonResponse({ error: 'slow down' }, 429)) as typeof fetch,
    });
    const error = await client.getCompanyReport('BBCA').catch((e) => e);
    expect(error.code).toBe('RATE_LIMIT');
  });

  it('maps 500 to SERVER_ERROR', async () => {
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => jsonResponse({ error: 'boom' }, 500)) as typeof fetch,
    });
    const error = await client.getCompanyReport('BBCA').catch((e) => e);
    expect(error.code).toBe('SERVER_ERROR');
  });

  it('maps 401 to UNAUTHORIZED with key suggestion', async () => {
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => jsonResponse({ error: 'nope' }, 401)) as typeof fetch,
    });
    const error = await client.getCompanyReport('BBCA').catch((e) => e);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.suggestion).toContain('SECTORS_API_KEY');
  });

  it('maps abort to TIMEOUT', async () => {
    const slowFetch = (async (_url: string, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
      return jsonResponse(REPORT);
    }) as unknown as typeof fetch;

    const client = new SectorsClient({ cacheDir, timeoutMs: 25, fetchImpl: slowFetch });
    const error = await client.getCompanyReport('BBCA').catch((e) => e);
    expect(error).toBeInstanceOf(SectorsApiError);
    expect(error.code).toBe('TIMEOUT');
  });

  it('does not cache errors (404 is refetched)', async () => {
    let hits = 0;
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => {
        hits += 1;
        return jsonResponse({ error: 'not found' }, 404);
      }) as typeof fetch,
    });
    await client.getCompanyReport('XYZ').catch(() => undefined);
    await client.getCompanyReport('XYZ').catch(() => undefined);
    expect(hits).toBe(2);
  });

  it('screens and ranks by deterministic match score', async () => {
    const rows = [
      { ticker: 'A', roe: 20, revenueGrowthYoy: 8, netIncomeGrowthYoy: 7 },
      { ticker: 'B', roe: -2, revenueGrowthYoy: 1, netIncomeGrowthYoy: -1 },
    ];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => jsonResponse(rows)) as typeof fetch,
    });

    const results = await client.screen(['profitable', 'growing']);
    expect(results.map((r) => r.ticker)).toEqual(['A', 'B']);
    expect(results[0].matchScore).toBe(100);
    // B: roe negatif (tidak profitable) tetapi revenue tumbuh → 30
    expect(results[1].matchScore).toBe(30);
  });
});

describe('computeMatchScore', () => {
  it('scores profitable and growing criteria deterministically', () => {
    const row = { ticker: 'X', roe: 15, revenueGrowthYoy: 6, netIncomeGrowthYoy: 5 };
    expect(computeMatchScore(row, ['profitable', 'growing'])).toBe(100);
    expect(computeMatchScore(row, ['profitable'])).toBe(50);
    expect(computeMatchScore(row, ['growing'])).toBe(50);
    expect(computeMatchScore({ ticker: 'Y', roe: -1 }, ['profitable'])).toBe(0);
  });
});

describe('MockSectorsApi', () => {
  const api = new MockSectorsApi();

  it('serves fixtures for known tickers', async () => {
    const report = await api.getCompanyReport('BBCA');
    expect(report.financials.roe).toBe(23.1);
    const fin = await api.getQuarterlyFinancials('BBCA');
    expect(fin.quarters[0].period).toBe('2024-Q4');
  });

  it('throws NOT_FOUND for unknown tickers (like the real client)', async () => {
    const error = await api.getCompanyReport('ZZZZ').catch((e) => e);
    expect(error).toBeInstanceOf(SectorsApiError);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('screens the whole mock universe', async () => {
    const results = await api.screen(['profitable', 'growing']);
    expect(results.length).toBe(5);
    expect(results[0].ticker).toBe('BBCA');
  });
});
