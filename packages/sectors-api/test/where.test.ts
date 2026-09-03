import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWhereClause, SectorsClient } from '../src/index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('buildWhereClause (Phase 3 Task 3)', () => {
  it('mapping profitable → roe>0 dan growing → yoy_quarter_revenue_growth>0', () => {
    expect(buildWhereClause(['profitable'])).toBe('roe>0');
    expect(buildWhereClause(['growing'])).toBe('yoy_quarter_revenue_growth>0');
    expect(buildWhereClause(['profitable', 'growing'])).toBe('roe>0 AND yoy_quarter_revenue_growth>0');
  });

  it('kriteria tak dikenal → null (fallback client-side)', () => {
    expect(buildWhereClause(['unknown'])).toBeNull();
    expect(buildWhereClause([])).toBeNull();
  });

  it('case-insensitive', () => {
    expect(buildWhereClause(['PROFITABLE'])).toBe('roe>0');
    expect(buildWhereClause(['Growing'])).toBe('yoy_quarter_revenue_growth>0');
  });
});

describe('SectorsClient.screen where SQL-native (Phase 3 Task 3)', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'finharness-where-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('mengirim ?where= untuk kriteria dikenal', async () => {
    const urls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return jsonResponse({ results: [{ symbol: 'A.JK', yoy_quarter_revenue_growth: 0.08, yoy_quarter_earnings_growth: 0.07 }] });
      }) as typeof fetch,
    });
    await client.screen(['profitable']);
    expect(urls[0]).toContain('where=');
    expect(decodeURIComponent(urls[0])).toContain('roe>0');
  });

  it('fallback ke tanpa where bila where 400', async () => {
    let calls = 0;
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        calls++;
        if (url.includes('where=')) return jsonResponse({ error: 'bad where' }, 400);
        return jsonResponse({ results: [{ symbol: 'A.JK', yoy_quarter_revenue_growth: 0.08, yoy_quarter_earnings_growth: 0.07 }] });
      }) as typeof fetch,
    });
    // pakai growing agar fallback scoring menghasilkan matchScore>0 (profitable skor 0 di v2)
    const results = await client.screen(['growing']);
    expect(calls).toBe(2);
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe('A');
  });

  it('tanpa where bila kriteria tak dikenal (fallback client-side)', async () => {
    const urls: string[] = [];
    const client = new SectorsClient({
      cacheDir,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return jsonResponse({ results: [] });
      }) as typeof fetch,
    });
    await client.screen(['unknown']);
    expect(urls[0]).not.toContain('where=');
  });
});
