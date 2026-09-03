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

describe('ClaimValidator.validateChallenge — run-scoped untuk Bear (Phase 1)', () => {
  it('challenge valid lolos (target claim id + evidence dalam run)', async () => {
    await expect(
      validator.validateChallenge(
        [
          { targetClaimId: 'claim_001', argument: 'ROE may partly reflect leverage.', strength: 'moderate' },
          { targetClaimId: 'claim_002', argument: 'Growth rests on one quarter.', strength: 'high' },
        ],
        allowedIds,
        { claimIds: ['claim_001', 'claim_002'], evidenceIds: allowedIds },
      ),
    ).resolves.toBeUndefined();
  });

  it('targetClaimId di luar klaim run ditolak', async () => {
    await expect(
      validator.validateChallenge(
        [{ targetClaimId: 'claim_unknown', argument: 'This claim does not exist in the run.', strength: 'low' }],
        allowedIds,
        { claimIds: ['claim_001'], evidenceIds: allowedIds },
      ),
    ).rejects.toThrow(/targets unknown claim claim_unknown/);
  });

  it('evidenceId Bear tidak ada di DB ditolak', async () => {
    await expect(
      validator.validateChallenge(
        [{ targetClaimId: 'claim_001', argument: 'Challenge based on invented data.', strength: 'low' }],
        ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
        { claimIds: ['claim_001'], evidenceIds: allowedIds },
      ),
    ).rejects.toThrow(/does not exist in database \(bear challenge\)/);
  });

  it('evidenceId Bear ada di DB tapi milik run lain ditolak', async () => {
    const otherRun = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
    const outsider = await db.evidence.save({
      runId: otherRun.id,
      ticker: 'BBRI',
      source: 'sectors.company_report',
      data: { roe: 20.3 },
    });
    await expect(
      validator.validateChallenge(
        [{ targetClaimId: 'claim_001', argument: 'Challenge based on another run data.', strength: 'low' }],
        [outsider.id],
        { claimIds: ['claim_001'], evidenceIds: allowedIds },
      ),
    ).rejects.toThrow(/not in allowed set for this run \(bear challenge\)/);
  });
});

describe('ClaimValidator.assertSeenEvidence — invariant "yang dilihat = yang dicatat" (§24-B.1)', () => {
  it('lolos saat evidenceIds ⊆ seenIds (inklusi, bukan equality)', () => {
    expect(() => validator.assertSeenEvidence(['1111', '2222'], ['1111', '2222', '3333'])).not.toThrow();
    expect(() => validator.assertSeenEvidence([], ['1111'])).not.toThrow();
  });

  it('melempar ValidationError saat klaim merujuk evidence yang "tidak pernah dilihat"', () => {
    expect(() => validator.assertSeenEvidence(['1111', '9999'], ['1111', '2222'])).toThrow(/never saw/);
  });
});
