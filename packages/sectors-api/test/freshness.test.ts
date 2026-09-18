import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cacheKeyFor, SectorsApiError, SectorsClient, type SectorsApiOptions, type SectorsCacheRequirement } from '../src/index';

/**
 * Audit doc F (cache freshness berbasis data-date, bukan fetchedAt semata).
 * Menegakkan:
 *  - cache menyimpan meta (period/dataAsOf/source) → membedakan "kapan fetch"
 *    dari "data untuk periode/tanggal apa".
 *  - data periodik (company_report/quarterly_financials) TIDAK di-refetch tiap
 *    ganti hari kalender selama TTL periodik belum lewat.
 *  - data harian (daily) di-refetch pada tanggal berbeda (calendarDay).
 *  - cache bertahan di-restart (instances baru atas dir yang sama).
 *  - error API tidak menghapus cache yang masih valid.
 */

const V2_REPORT = {
  symbol: 'BBCA.JK',
  company_name: 'Bank Central Asia',
  overview: { sector: 'Financials' },
  valuation: { last_close_price: 9850, latest_close_date: '2025-01-10', forward_pe: 4.6, historical_valuation: [{ year: 2024, pb: 1.6, pe: 4.6 }] },
  financials: { historical_financials: [{ year: 2024, revenue: 300000, earnings: 105000, total_assets: 600000, total_equity: 500000 }] },
  dividend: { historical_dividends: { '2024': { total_yield: 0.031 } } },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Client dengan fetchStub terhitung; tertentu jalur yang memicu error. */
function countingClient(cacheDir: string, options: Partial<SectorsApiOptions> = {}) {
  let companyFetches = 0;
  let dailyFetches = 0;
  const client = new SectorsClient({ ...options, cacheDir, fetchImpl: (async (url: string) => {
    if (url.includes('/company/report')) { companyFetches++; return jsonResponse(V2_REPORT); }
    if (url.includes('/daily/')) { dailyFetches++; return jsonResponse([]); }
    return jsonResponse({});
  }) as typeof fetch });
  return { client, count: () => ({ company: companyFetches, daily: dailyFetches }) };
}

/** Backdate langsung field fetchedAt pada file cache tertentu (simulasi hari lalu). */
function backdate(cacheDir: string, fileName: string, daysAgo = 1): void {
  const file = join(cacheDir, fileName);
  const entry = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string };
  entry.fetchedAt = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  writeFileSync(file, JSON.stringify(entry));
}

function cachedFile(cacheDir: string, operation: string): string {
  const file = readdirSync(cacheDir).find((name) => name.includes(`_${operation}_`) && name.endsWith('.json'));
  if (!file) throw new Error(`No cache entry for ${operation}`);
  return file;
}

function requirementFor(operation: string, ticker: string, params: Record<string, unknown>, kind: SectorsCacheRequirement['temporal']['kind']): string {
  return `${cacheKeyFor({
    provider: 'sectors-api', operation, subjectScope: 'symbol', subject: ticker,
    params, temporal: { kind }, schemaVersion: 1, adapterVersion: 'v2',
  })}.json`;
}

describe('Sectors cache freshness (Audit doc F)', () => {
  let cacheDir: string;
  beforeEach(() => { cacheDir = mkdtempSync(join(tmpdir(), 'finharness-freshness-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  it('cache hit pada tanggal sama → tidak fetch ulang', async () => {
    const { client, count } = countingClient(cacheDir);
    const first = await client.getCompanyReport('BBCA');
    const second = await client.getCompanyReport('BBCA');
    expect(first.ticker).toBe('BBCA');
    expect(second).toEqual(first);
    expect(count().company).toBe(1);
  });

  it('cache menyimpan meta period/dataAsOf/source (bukan hanya fetchedAt)', async () => {
    const { client } = countingClient(cacheDir);
    await client.getCompanyReport('BBCA');
    const entry = JSON.parse(readFileSync(join(cacheDir, cachedFile(cacheDir, 'company_report')), 'utf8')) as {
      meta?: { dataAsOf?: string; period?: string; source?: string };
    };
    expect(entry.meta?.dataAsOf).toBe('2025-01-10');
    expect(entry.meta?.period).toBeUndefined();
    expect(entry.meta?.source).toBe('sectors-api');
  });

  it('data periodik tidak di-refetch tiap ganti hari kalender saat TTL periodik belum lewat', async () => {
    const { client, count } = countingClient(cacheDir, { cacheTtlHours: 48 });
    await client.getCompanyReport('BBCA');
    // Backdate fetchedAt kemarin: periodik (tanpa calendarDay) tetap cache-hit dalam configured TTL.
    backdate(cacheDir, cachedFile(cacheDir, 'company_report'));
    const second = await client.getCompanyReport('BBCA');
    expect(second.ticker).toBe('BBCA');
    expect(count().company).toBe(1);
  });

  it('mixed Company Report revalidates reference-sensitive values instead of using profile-long freshness', async () => {
    let now = new Date('2026-09-17T12:00:00Z');
    let fetches = 0;
    const client = new SectorsClient({
      cacheDir,
      now: () => now,
      fetchImpl: (async () => {
        fetches += 1;
        return jsonResponse({ ...V2_REPORT, valuation: { ...V2_REPORT.valuation, last_close_price: fetches } });
      }) as typeof fetch,
    });
    expect((await client.getCompanyReport('BBCA')).valuation.price).toBe(1);
    now = new Date('2026-09-19T12:00:00Z');
    expect((await client.getCompanyReport('BBCA')).valuation.price).toBe(2);
    expect(fetches).toBe(2);
  });

  it('data harian (daily) di-refetch pada tanggal berbeda (calendarDay)', async () => {
    const { client, count } = countingClient(cacheDir);
    await client.getDailyTransaction('BBCA');
    expect(count().daily).toBe(1);
    // Backdate fetchedAt kemarin → calendarDay menganggap hari baru → refetch.
    backdate(cacheDir, cachedFile(cacheDir, 'daily_transaction'));
    await client.getDailyTransaction('BBCA');
    expect(count().daily).toBe(2);
  });

  it('cache bertahan setelah instance baru (simulated restart) pada dir yang sama', async () => {
    const am = countingClient(cacheDir);
    await am.client.getCompanyReport('BBCA');
    expect(am.count().company).toBe(1);
    // Instance baru atas dir sama → tidak fetch ulang.
    const pm = countingClient(cacheDir);
    await pm.client.getCompanyReport('BBCA');
    expect(pm.count().company).toBe(0);
  });

  it('miss ketika ticker belum pernah diambil', async () => {
    const { client, count } = countingClient(cacheDir);
    await client.getCompanyReport('BBCA');
    await client.getCompanyReport('BBRI'); // belum ada → fetch
    expect(count().company).toBe(2);
  });

  it('error API tidak menghapus cache (walaupun sudah stale → miss), dan tetap ada di disk', async () => {
    // Seed entry periodik yang sudah kedaluwarsa (> TTL 7 hari) pada dir baru.
    const file = join(cacheDir, requirementFor('company_report', 'BBCA', { sections: ['overview', 'valuation', 'financials', 'dividend'] }, 'mixed_snapshot'));
    writeFileSync(file, JSON.stringify({ fetchedAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), data: V2_REPORT, meta: { period: '2025-Q1', source: 'sectors-api' } }));
    // Client yang fetch-nya selalu gagal → miss + error.
    const failing = new SectorsClient({ cacheDir, fetchImpl: (async () => {
      throw new SectorsApiError('SERVER_ERROR', 'boom', 'retry');
    }) as typeof fetch });
    await expect(failing.getCompanyReport('BBCA')).rejects.toThrow();
    expect(existsSync(file)).toBe(true); // file tidak dihapus walau fetch gagal
  });
});
