import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

describe('Normalized tables (Phase 9A)', () => {
  let db: FinharnessDatabase;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-norm-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('upsertFinancials inserts and lists', async () => {
    await db.normalized.upsertFinancials({ ticker: 'BBCA', year: 2024, revenue: 100, earnings: 50, roe: 12.5, netMargin: 5 });
    const rows = await db.normalized.listFinancials('BBCA');
    expect(rows.length).toBe(1);
    expect(rows[0].roe).toBeCloseTo(12.5);
  });

  it('upsert is idempotent (overwrite)', async () => {
    await db.normalized.upsertFinancials({ ticker: 'BBCA', year: 2024, revenue: 100 });
    await db.normalized.upsertFinancials({ ticker: 'BBCA', year: 2024, revenue: 200 });
    const rows = await db.normalized.listFinancials('BBCA');
    expect(rows.length).toBe(1);
    expect(rows[0].revenue).toBe(200);
  });

  it('daily upsert + list', async () => {
    await db.normalized.upsertDaily({ ticker: 'BBCA', date: '2024-01-10', closePrice: 9850, volume: 100000 });
    await db.normalized.upsertDaily({ ticker: 'BBCA', date: '2024-01-10', closePrice: 9900 });
    const rows = await db.normalized.listDaily('BBCA');
    expect(rows.length).toBe(1);
    expect(rows[0].closePrice).toBe(9900);
  });

  it('migration idempotent — open kedua tidak error', async () => {
    db.raw.close();
    const db2 = openDb({ homeDir: dir });
    await db2.normalized.upsertFinancials({ ticker: 'BBRI', year: 2023, roe: 10 });
    const rows = await db2.normalized.listFinancials('BBRI');
    expect(rows.length).toBe(1);
    db2.raw.close();
    // prevent afterEach double close
    db = { raw: { close: () => {} } } as unknown as FinharnessDatabase;
  });
});
