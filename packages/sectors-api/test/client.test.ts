import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeMatchScore, MockSectorsApi, SectorsApiError, SectorsClient } from '../src/index';

/**
 * Test client Sectors API **v2** (v1 discontinued 2026-05-11). Client menormalisasi
 * response v2 → bentuk canonical; assertion memastikan path v2 + hasil transform.
 */

// Response v2 mentah untuk getCompanyReport (BBCA) — dipakai utk uji transform.
const V2_REPORT = {
  symbol: 'BBCA.JK',
  company_name: 'Bank Central Asia',
  overview: { sector: 'Financials' },
  valuation: {
    last_close_price: 9850,
    latest_close_date: '2025-01-10',
    forward_pe: 4.6,
    historical_valuation: [{ year: 2024, pb: 1.6, pe: 4.6 }],
  },
  financials: {
    historical_financials: [{ year: 2024, revenue: 300000, earnings: 105000, total_assets: 600000, total_equity: 500000 }],
  },
  dividend: { historical_dividends: { '2024': { total_yield: 0.031 } } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Client dengan fetchStub yang mengembalikan nilai `body` untuk semua URL. */
function stubClient(body: unknown, cacheDir: string): SectorsClient {
  return new SectorsClient({ cacheDir, fetchImpl: (async () => jsonResponse(body)) as typeof fetch });
}

describe('SectorsClient (v2)', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'finharness-sectors-cache-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('matches YoY by calendar quarter and does not label rolling quarters as YTD', async () => {
    const quarters = [
      { symbol: 'BBCA.JK', date: '2025-09-30', revenue: 120, earnings: 0 },
      { symbol: 'BBCA.JK', date: '2025-03-31', revenue: 110, earnings: 5 },
      { symbol: 'BBCA.JK', date: '2024-12-31', revenue: 105, earnings: 5 },
      { symbol: 'BBCA.JK', date: '2024-09-30', revenue: 100, earnings: 5 },
      { symbol: 'BBCA.JK', date: '2024-06-30', revenue: 80, earnings: 4 },
      { symbol: 'BBCA.JK', date: '2024-03-31', revenue: 90, earnings: 4 },
    ];
    const fin = await stubClient(quarters, cacheDir).getQuarterlyFinancials('BBCA');
    expect(fin.quarters[0].revenueGrowthYoy).toBeCloseTo(20);
    expect(fin.quarters[0].netIncomeGrowthYoy).toBe(-100);
    expect(fin.cumulativeYtd).toBeUndefined();
  });

  it('fills missing ROE from bounded cached company reports for profitable screening', async () => {
    let reports = 0;
    const client = new SectorsClient({ cacheDir, fetchImpl: (async (url: string) => {
      if (url.includes('/company/report')) { reports++; return jsonResponse(V2_REPORT); }
      return jsonResponse({ results: [{ symbol: 'BBCA.JK', company_name: 'Bank Central Asia' }] });
    }) as typeof fetch });
    const results = await client.screen(['profitable']);
    expect(results[0]).toMatchObject({ ticker: 'BBCA', roe: 21, matchScore: 50 });
    await client.screen(['profitable']);
    expect(reports).toBe(1);
  });

  it('fetches company report (v2 path) and normalizes to canonical', async () => {
    const calls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return jsonResponse(V2_REPORT);
      }) as typeof fetch,
    });

    const report = await client.getCompanyReport('BBCA');
    expect(calls).toEqual(['https://api.sectors.app/v2/company/report/BBCA/?sections=overview%2Cvaluation%2Cfinancials%2Cdividend']);
    expect(report).toMatchObject({
      ticker: 'BBCA',
      name: 'Bank Central Asia',
      sector: 'Financials',
      asOf: '2025-01-10',
    });
    // roe = earnings/total_equity; netMargin = earnings/revenue (dalam %)
    expect(report.financials.roe).toBeCloseTo(21);
    expect(report.financials.netMargin).toBeCloseTo(35);
    expect(report.valuation.price).toBe(9850);
    expect(report.valuation.pe).toBe(4.6);
    expect(report.valuation.pb).toBeCloseTo(1.6);
    expect(report.valuation.dividendYield).toBeCloseTo(3.1);
  });

  it('preserves /judge Company Report output when only consumed sections are returned', async () => {
    const omitted = { future: { earnings_estimates: [] }, peers: [], management: [], ownership: [] };
    const full = {
      ...V2_REPORT,
      ...omitted,
    };
    const reduced = {
      symbol: V2_REPORT.symbol,
      company_name: V2_REPORT.company_name,
      overview: V2_REPORT.overview,
      valuation: V2_REPORT.valuation,
      financials: V2_REPORT.financials,
      dividend: V2_REPORT.dividend,
    };
    const make = (body: unknown) => new SectorsClient({
      cacheDir: mkdtempSync(join(tmpdir(), 'finharness-report-parity-')),
      fetchImpl: (async () => jsonResponse(body)) as typeof fetch,
    });
    const fullReport = await make(full).getCompanyReport('BBCA');
    const reducedReport = await make(reduced).getCompanyReport('BBCA');
    expect(reducedReport).toEqual(fullReport);
  });

  it('proves n_quarters=1 preserves the normalized latest quarter and YoY consumed by /judge', async () => {
    const reportWithGrowth = {
      ...V2_REPORT,
      financials: {
        ...V2_REPORT.financials,
        yoy_quarter_revenue_growth: 0.1,
        yoy_quarter_earnings_growth: 0.08,
      },
    };
    const fullRows = [
      { symbol: 'BBCA.JK', date: '2025-12-31', revenue: 110, earnings: 54 },
      { symbol: 'BBCA.JK', date: '2024-12-31', revenue: 100, earnings: 50 },
      { symbol: 'BBCA.JK', date: '2025-09-30', revenue: 90, earnings: 45 },
    ];
    const latestOnly = [fullRows[0]];
    const calls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        if (url.includes('/company/report')) return jsonResponse(reportWithGrowth);
        return jsonResponse(url.includes('n_quarters=1') ? latestOnly : fullRows);
      }) as typeof fetch,
    });
    await client.getCompanyReport('BBCA');
    const normalized = await client.getQuarterlyFinancials('BBCA');
    expect(calls).toContain('https://api.sectors.app/v2/financials/quarterly/BBCA/?n_quarters=1&approx=true');
    expect(normalized.quarters[0]).toMatchObject({
      period: '2025-Q4', revenue: 110, netIncome: 54,
      revenueGrowthYoy: 10, netIncomeGrowthYoy: 8,
    });
    const fullClient = new SectorsClient({
      cacheDir: mkdtempSync(join(tmpdir(), 'finharness-quarter-parity-full-')),
      fetchImpl: (async (url: string) => jsonResponse(url.includes('/company/report') ? reportWithGrowth : fullRows)) as typeof fetch,
    });
    await fullClient.getCompanyReport('BBCA');
    const fullNormalized = await fullClient.getQuarterlyFinancials('BBCA');
    expect(normalized.quarters[0]).toEqual(fullNormalized.quarters[0]);
  });

  it('retains multi-row YoY derivation as a correctness fallback when report growth is absent', async () => {
    const calls: string[] = [];
    const rows = [
      { symbol: 'BBCA.JK', date: '2025-12-31', revenue: 110, earnings: 54 },
      { symbol: 'BBCA.JK', date: '2024-12-31', revenue: 100, earnings: 50 },
    ];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        if (url.includes('/company/report')) return jsonResponse(V2_REPORT);
        return jsonResponse(url.includes('n_quarters=1') ? [rows[0]] : rows);
      }) as typeof fetch,
    });
    const fin = await client.getQuarterlyFinancials('BBCA');
    expect(fin.quarters[0]).toMatchObject({ revenueGrowthYoy: 10, netIncomeGrowthYoy: 8 });
    expect(calls.filter((url) => url.includes('/financials/quarterly')).length).toBe(2);
  });

  it('boundedly revalidates latest financials after the configured window', async () => {
    let now = new Date('2026-09-17T12:00:00Z');
    let quarterlyFetches = 0;
    const client = new SectorsClient({
      cacheDir,
      cacheTtlHours: 1,
      now: () => now,
      fetchImpl: (async (url: string) => {
        if (url.includes('/company/report')) return jsonResponse({
          ...V2_REPORT,
          financials: { ...V2_REPORT.financials, yoy_quarter_revenue_growth: 0.1, yoy_quarter_earnings_growth: 0.08 },
        });
        quarterlyFetches += 1;
        return jsonResponse([{ symbol: 'BBCA.JK', date: quarterlyFetches === 1 ? '2025-12-31' : '2026-03-31', revenue: 110, earnings: 54 }]);
      }) as typeof fetch,
    });
    expect((await client.getQuarterlyFinancials('BBCA')).quarters[0].period).toBe('2025-Q4');
    now = new Date('2026-09-17T14:00:00Z');
    expect((await client.getQuarterlyFinancials('BBCA')).quarters[0].period).toBe('2026-Q1');
    expect(quarterlyFetches).toBe(2);
  });

  it('reuses a compatible subject-specific request across client/workflow instances but not across subjects', async () => {
    let hits = 0;
    const fetchImpl = (async (url: string) => {
      hits += 1;
      if (url.includes('/company/report')) return jsonResponse({
        ...V2_REPORT,
        financials: { ...V2_REPORT.financials, yoy_quarter_revenue_growth: 0.1, yoy_quarter_earnings_growth: 0.08 },
      });
      return jsonResponse([{ symbol: 'BBCA.JK', date: '2025-12-31', revenue: 1, earnings: 1 }]);
    }) as typeof fetch;
    await new SectorsClient({ cacheDir, fetchImpl }).getQuarterlyFinancials('BBCA');
    await new SectorsClient({ cacheDir, fetchImpl }).getQuarterlyFinancials('BBCA');
    await new SectorsClient({ cacheDir, fetchImpl }).getQuarterlyFinancials('BBRI');
    // Each subject needs its own report + quarterly provider responses; the
    // second BBCA workflow reuses both responses, while BBRI cannot reuse them.
    expect(hits).toBe(4);
  });

  it('sends Authorization header WITHOUT the Bearer prefix (v2 auth)', async () => {
    let header: string | undefined;
    const client = new SectorsClient({
      cacheDir,
      apiKey: 'sk-test',
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        header = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return jsonResponse(V2_REPORT);
      }) as typeof fetch,
    });
    await client.getCompanyReport('BBCA');
    expect(header).toBe('sk-test');
  });

  it('normalizes quarterly financials array (v2) to canonical quarters w/ YoY', async () => {
    const v2Quarterly = [
      { symbol: 'BBCA.JK', date: '2024-12-31', revenue: 11000, earnings: 4000 },
      { symbol: 'BBCA.JK', date: '2024-09-30', revenue: 10500, earnings: 3800 },
      { symbol: 'BBCA.JK', date: '2024-06-30', revenue: 10000, earnings: 3600 },
      { symbol: 'BBCA.JK', date: '2024-03-31', revenue: 9500, earnings: 3400 },
      { symbol: 'BBCA.JK', date: '2023-12-31', revenue: 10000, earnings: 3680 },
    ];
    const client = stubClient(v2Quarterly, cacheDir);
    const fin = await client.getQuarterlyFinancials('BBCA');
    expect(fin.quarters[0].period).toBe('2024-Q4');
    expect(fin.quarters[0].revenue).toBe(11000);
    // YoY kuartal 2024-Q4 vs 2023-Q4: (11000-10000)/10000=10%
    expect(fin.quarters[0].revenueGrowthYoy).toBeCloseTo(10);
    expect((await client.getQuarterlyFinancials('BBCA')).quarters[0]).toEqual(fin.quarters[0]);
  });

  it('fills YoY from company report when quarterly returns single row (fix #17)', async () => {
    const v2Report = {
      symbol: 'BBCA.JK',
      company_name: 'Bank Central Asia',
      overview: { sector: 'Financials' },
      valuation: { last_close_price: 9850, latest_close_date: '2025-01-10', forward_pe: 4.6, historical_valuation: [{ year: 2024, pb: 1.6 }] },
      financials: {
        historical_financials: [{ year: 2024, revenue: 300000, earnings: 105000, total_assets: 600000, total_equity: 500000 }],
        yoy_quarter_revenue_growth: 0.098,
        yoy_quarter_earnings_growth: 0.087,
      },
      dividend: { historical_dividends: { '2024': { total_yield: 0.031 } } },
    };
    const calls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        if (url.includes('/company/report')) return jsonResponse(v2Report);
        return jsonResponse([{ symbol: 'BBCA.JK', date: '2024-12-31', revenue: 11000, earnings: 4000 }]);
      }) as typeof fetch,
    });
    // Report first → cached, then quarterly enriches from cache (no extra report fetch on second quarterly call)
    const report = await client.getCompanyReport('BBCA');
    expect(report.financials.yoyQuarterRevenueGrowth).toBeCloseTo(9.8);
    expect(report.financials.yoyQuarterEarningsGrowth).toBeCloseTo(8.7);
    const fin = await client.getQuarterlyFinancials('BBCA');
    expect(fin.quarters[0].revenueGrowthYoy).toBeCloseTo(9.8);
    expect(fin.quarters[0].netIncomeGrowthYoy).toBeCloseTo(8.7);
    expect(calls.filter((u) => u.includes('/company/report')).length).toBe(1);
    expect(calls.filter((u) => u.includes('/financials/quarterly')).length).toBe(1);
    // Second quarterly call → cache hit, no network
    calls.length = 0;
    const fin2 = await client.getQuarterlyFinancials('BBCA');
    expect(fin2.quarters[0].revenueGrowthYoy).toBeCloseTo(9.8);
    expect(calls.length).toBe(0);
  });

  it('uses file cache on second call (no second API hit)', async () => {
    let hits = 0;
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async () => {
        hits += 1;
        return jsonResponse(V2_REPORT);
      }) as typeof fetch,
    });
    const first = await client.getCompanyReport('BBCA');
    const second = await client.getCompanyReport('BBCA');
    expect(first).toEqual(second);
    expect(hits).toBe(1);
  });

  it('maps http errors to SectorsApiError codes', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [429, 'RATE_LIMIT'],
      [500, 'SERVER_ERROR'],
    ] as Array<[number, string]>) {
      const client = stubClient({ error: 'x' }, cacheDir) as SectorsClient & { _stub?: never };
      const c = new SectorsClient({ cacheDir, fetchImpl: (async () => jsonResponse({ error: 'x' }, status)) as typeof fetch });
      const error = await c.getCompanyReport('XYZ').catch((e) => e);
      expect(error).toBeInstanceOf(SectorsApiError);
      expect(error.code).toBe(code);
    }
    const client = new SectorsClient({ cacheDir, fetchImpl: (async () => jsonResponse({ error: 'nope' }, 401)) as typeof fetch });
    const error = await client.getCompanyReport('BBCA').catch((e) => e);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.suggestion).toContain('SECTORS_API_KEY');
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

  it('maps 404 on company report to NOT_FOUND with ticker', async () => {
    const client = new SectorsClient({ cacheDir, fetchImpl: (async () => jsonResponse({ error: 'no' }, 404)) as typeof fetch });
    const error = await client.getCompanyReport('XYZ').catch((e) => e);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('XYZ');
  });

  it('screens /v2/companies and scores yoy growth (roe unavailable in v2 screener)', async () => {
    const v2Results = {
      results: [
        { symbol: 'A.JK', yoy_quarter_revenue_growth: 0.08, yoy_quarter_earnings_growth: 0.07 },
        { symbol: 'B.JK', yoy_quarter_revenue_growth: 0.01, yoy_quarter_earnings_growth: -0.01 },
      ],
    };
    const client = stubClient(v2Results, cacheDir);
    const results = await client.screen(['profitable', 'growing']);
    expect(results.map((r) => r.ticker)).toEqual(['A', 'B']);
    // roe di v2 screener tidak tersedia → 'profitable' tidak menambah skor (Deviasi)
    // A: growing (rev +30, earn +20) = 50 ; B: rev>0 saja = 30
    expect(results[0].matchScore).toBe(50);
    expect(results[1].matchScore).toBe(30);
  });
});

describe('Market & News Researcher (Phase 1, v2)', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'finharness-sectors-cache-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('normalizes daily array and foreign flow (v2) to canonical', async () => {
    const calls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        if (url.includes('/daily/'))
          return jsonResponse([
            { symbol: 'BBCA.JK', date: '2025-01-10', close: 9850, open: 9800, volume: 10_000_000, market_cap: 1e15 },
          ]);
        return jsonResponse({
          symbol: 'BBCA.JK',
          data: [
            { date: '2025-01-09', net_foreign_inflow: 500_000_000 },
            { date: '2025-01-10', net_foreign_inflow: -200_000_000 },
          ],
        });
      }) as typeof fetch,
    });

    const daily = await client.getDailyTransaction('BBCA');
    expect(daily.window).toBe('1d');
    expect(daily.upDaysPct).toBe(100); // close > open
    expect(daily.avgValueBillion).toBeCloseTo(98.5); // 9850 * 10M / 1e9

    const foreign = await client.getForeignFlow('BBCA');
    expect(foreign.netFlow).toBe('buy'); // sum inflow > 0
    expect(foreign.netBuyDaysPct).toBe(50);

    expect(calls[0]).toMatch(/\/v2\/daily\/BBCA\//);
    expect(calls[1]).toMatch(/\/v2\/foreign-flow\/BBCA\//);
  });

  it('normalizes news & filings and derives sentiment (no /sentiment endpoint in v2)', async () => {
    const calls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls.push(url);
        if (url.includes('/news/'))
          return jsonResponse({ results: [{ title: 'hi', source: 'u', timestamp: '2025-01-10', tags: ['Bullish'], symbols: ['BBCA.JK'], body: 'x' }] });
        if (url.includes('/filings/'))
          return jsonResponse({ results: [{ title: 'f', source: 'u', timestamp: '2025-01-10', symbol: 'BBCA.JK', transaction_type: 'insider_buy' }] });
        return jsonResponse({ symbol: 'BBCA.JK', data: [{ date: '2025-01-10', net_foreign_inflow: 1000 }] });
      }) as typeof fetch,
    });

    const news = await client.getNews('BBCA');
    expect(news[0].headline).toBe('hi');
    expect(news[0].sentiment).toBe('positive'); // tag Bullish

    const filings = await client.getFilings('BBCA');
    expect(filings[0].type).toBe('insider_buy');

    const sentiment = await client.getSentiment('BBCA');
    expect(typeof sentiment.aggregate).toBe('number');
    expect(sentiment.aggregate as number).toBeGreaterThan(0); // news bullish + foreign buy

    // sentiment tidak memanggil /sentiment; hanya /news + /foreign-flow
    expect(calls.every((u) => !u.includes('/sentiment'))).toBe(true);
  });

  it('applies short news TTL while retaining completed daily history for the local date', async () => {
    let hits = 0;
    let now = new Date('2026-09-17T12:00:00Z');
    const client = new SectorsClient({
      cacheDir,
      cacheTtlHours: 24,
      newsCacheTtlHours: 1,
      now: () => now,
      fetchImpl: (async () => {
        hits += 1;
        return jsonResponse([]);
      }) as typeof fetch,
    });
    await client.getNews('BBCA');
    await client.getDailyTransaction('BBCA');
    now = new Date('2026-09-17T14:00:00Z');
    await client.getNews('BBCA');
    await client.getDailyTransaction('BBCA');
    expect(hits).toBe(3);
  });

  it('maps 404 on market endpoint to NOT_FOUND', async () => {
    const client = new SectorsClient({ cacheDir, fetchImpl: (async () => jsonResponse({ error: 'no' }, 404)) as typeof fetch });
    const error = await client.getDailyTransaction('XYZ').catch((e) => e);
    expect(error).toBeInstanceOf(SectorsApiError);
    expect(error.code).toBe('NOT_FOUND');
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

  it('serves canonical fixtures for known tickers', async () => {
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

  it('screens the whole mock universe (deterministic)', async () => {
    const results = await api.screen(['profitable', 'growing']);
    expect(results.length).toBe(5);
    expect(results[0].ticker).toBe('BBCA');
  });

  it('serves deterministic market/news fixtures distinguishing liquidity & sentiment', async () => {
    const daily = await api.getDailyTransaction('BBCA');
    expect(daily.liquidityBand).toBe('high');
    expect((await api.getForeignFlow('BBCA')).netFlow).toBe('buy');
    expect((await api.getSentiment('BBCA')).aggregate as number).toBeGreaterThan(0);
    expect((await api.getDailyTransaction('BJTM')).liquidityBand).toBe('low');
    expect((await api.getSentiment('BJTM')).aggregate as number).toBeLessThan(0);
  });
});
