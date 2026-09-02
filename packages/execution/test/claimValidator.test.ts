import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { ClaimValidator } from '@harness/execution';
import type { Claim } from '@harness/schemas';

let db: FinharnessDatabase;
let dir: string;
let validator: ClaimValidator;
let allowedIds: string[];
let validClaim: Claim;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-validator-'));
  db = openDb({ homeDir: dir });
  validator = new ClaimValidator(db.evidence);

  const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
  const e1 = await db.evidence.save({
    runId: run.id,
    ticker: 'BBCA',
    source: 'sectors.company_report',
    data: { roe: 23.1 },
  });
  const e2 = await db.evidence.save({
    runId: run.id,
    ticker: 'BBCA',
    source: 'sectors.quarterly_financials',
    data: { netIncomeGrowthYoY: 8.7 },
  });
  allowedIds = [e1.id, e2.id];
  validClaim = {
    claimId: 'claim_001',
    statement: 'Profitability remains strong with ROE 23.1%.',
    confidence: 'strong',
    reasoning: 'ROE 23.1% sourced directly from the company report.',
    evidenceIds: [e1.id],
  };
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('ClaimValidator — 3 layer (addendum §16)', () => {
  it('Layer 1: claim valid lolos', async () => {
    const parsed = await validator.validate([validClaim], allowedIds);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].claimId).toBe('claim_001');
  });

  it('Layer 1: evidenceIds kosong ditolak oleh Zod', async () => {
    const bad = { ...validClaim, evidenceIds: [] };
    await expect(validator.validate([bad], allowedIds)).rejects.toThrow();
  });

  it('Layer 1: statement terlalu pendek ditolak', async () => {
    const bad = { ...validClaim, statement: 'Short' };
    await expect(validator.validate([bad], allowedIds)).rejects.toThrow();
  });

  it('Layer 2: evidence hallucinated (tidak ada di DB) ditolak', async () => {
    const bad: Claim = {
      ...validClaim,
      evidenceIds: ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    };
    await expect(validator.validate([bad], allowedIds)).rejects.toThrow(
      /does not exist in database/,
    );
  });

  it('Layer 3: evidence ada di DB tapi di luar allowed set run ini ditolak', async () => {
    const otherRun = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
    const outsider = await db.evidence.save({
      runId: otherRun.id,
      ticker: 'BBRI',
      source: 'sectors.company_report',
      data: { roe: 20.3 },
    });

    const bad: Claim = { ...validClaim, evidenceIds: [outsider.id] };
    await expect(validator.validate([bad], allowedIds)).rejects.toThrow(
      /not in allowed set for this run/,
    );
  });
});
