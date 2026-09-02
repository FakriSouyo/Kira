import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { Claim, Judgment } from '@harness/schemas';

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-cj-test-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const CLAIM: Claim = {
  claimId: 'claim_1',
  statement: 'Profitability remains strong.',
  confidence: 'strong',
  reasoning: 'ROE of 23.1% indicates strong and efficient profitability for the bank.',
  evidenceIds: ['11111111-aaaa-4aaa-8aaa-111111111111'],
};

const JUDGMENT: Judgment = {
  ticker: 'BBCA',
  score: 72,
  stance: 'bullish',
  confidence: 'moderate',
  breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
  summary: 'Consistent, evidence-backed signals support a bullish stance.',
};

describe('ClaimStoreSqlite (Task 14)', () => {
  it('save lalu getByRun mengembalikan claim dengan evidenceIds utuh', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const otherRun = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });

    await db.claims.save({ runId: run.id, messageId: 'bull_1', claim: CLAIM });
    await db.claims.save({ runId: otherRun.id, messageId: 'bull_2', claim: { ...CLAIM, claimId: 'claim_x' } });

    const stored = await db.claims.getByRun(run.id);
    expect(stored).toHaveLength(1);
    expect(stored[0].claimId).toBe('claim_1');
    expect(stored[0].messageId).toBe('bull_1');
    expect(stored[0].evidenceIds).toEqual(CLAIM.evidenceIds);
    expect(stored[0].confidence).toBe('strong');
  });

  it('menegakkan UNIQUE(run_id, claim_id)', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    await db.claims.save({ runId: run.id, messageId: 'bull_1', claim: CLAIM });
    await expect(db.claims.save({ runId: run.id, messageId: 'bull_1', claim: CLAIM })).rejects.toThrow();
  });
});

describe('JudgmentStoreSqlite (Task 14)', () => {
  it('save lalu getByRun mengembalikan breakdown 5 kategori (momentum/risk null)', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });

    const saved = await db.judgments.save({ runId: run.id, judgment: JUDGMENT });
    const loaded = await db.judgments.getByRun(run.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(saved.id);
    expect(loaded!.score).toBe(72);
    expect(loaded!.stance).toBe('bullish');
    expect(loaded!.breakdown).toEqual(JUDGMENT.breakdown);
    expect(loaded!.breakdown.marketMomentum).toBeNull();
    expect(loaded!.breakdown.risk).toBeNull();
  });

  it('UNIQUE(run_id) — satu judgment per run', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    await db.judgments.save({ runId: run.id, judgment: JUDGMENT });
    await expect(db.judgments.save({ runId: run.id, judgment: JUDGMENT })).rejects.toThrow();
  });

  it('getByRun tanpa judgment → null', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    expect(await db.judgments.getByRun(run.id)).toBeNull();
  });
});
