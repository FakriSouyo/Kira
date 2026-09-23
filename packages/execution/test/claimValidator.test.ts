import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { ClaimValidator } from '@harness/execution';
import type { Claim } from '@harness/schemas';
import { insertLegacyEvidenceFixture } from '../../database/test/helpers/legacyEvidenceFixture';

let db: FinharnessDatabase;
let dir: string;
let validator: ClaimValidator;
let currentRunId: string;
let allowedIds: string[];
let validClaim: Claim;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-validator-'));
  db = openDb({ homeDir: dir });
  validator = new ClaimValidator(db.evidence);

  const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
  currentRunId = run.id;
  const e1 = insertLegacyEvidenceFixture(db.raw, {
    runId: run.id, ticker: 'BBCA', source: 'sectors.company_report', data: { roe: 23.1 },
  });
  const e2 = insertLegacyEvidenceFixture(db.raw, {
    runId: run.id, ticker: 'BBCA', source: 'sectors.quarterly_financials', data: { netIncomeGrowthYoY: 8.7 },
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
    const parsed = await validator.validate([validClaim], allowedIds, currentRunId);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].claimId).toBe('claim_001');
  });

  it('Layer 1: evidenceIds kosong ditolak oleh Zod', async () => {
    const bad = { ...validClaim, evidenceIds: [] };
    await expect(validator.validate([bad], allowedIds, currentRunId)).rejects.toThrow();
  });

  it('Layer 1: statement terlalu pendek ditolak', async () => {
    const bad = { ...validClaim, statement: 'Short' };
    await expect(validator.validate([bad], allowedIds, currentRunId)).rejects.toThrow();
  });

  it('Layer 2: evidence hallucinated (tidak ada di DB) ditolak', async () => {
    const bad: Claim = {
      ...validClaim,
      evidenceIds: ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    };
    await expect(validator.validate([bad], allowedIds, currentRunId)).rejects.toThrow(
      /does not exist in database/,
    );
  });

  it('Layer 3: evidence ada di DB tapi di luar allowed set run ini ditolak', async () => {
    const otherRun = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
    const outsider = insertLegacyEvidenceFixture(db.raw, {
      runId: otherRun.id, ticker: 'BBRI', source: 'sectors.company_report', data: { roe: 20.3 },
    });

    const bad: Claim = { ...validClaim, evidenceIds: [outsider.id] };
    await expect(validator.validate([bad], allowedIds, currentRunId)).rejects.toThrow(
      /does not exist in database/,
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
        { executionId: currentRunId, claimIds: ['claim_001', 'claim_002'], evidenceIds: allowedIds },
      ),
    ).resolves.toBeUndefined();
  });

  it('targetClaimId di luar klaim run ditolak', async () => {
    await expect(
      validator.validateChallenge(
        [{ targetClaimId: 'claim_unknown', argument: 'This claim does not exist in the run.', strength: 'low' }],
        allowedIds,
        { executionId: currentRunId, claimIds: ['claim_001'], evidenceIds: allowedIds },
      ),
    ).rejects.toThrow(/targets unknown claim claim_unknown/);
  });

  it('evidenceId Bear tidak ada di DB ditolak', async () => {
    await expect(
      validator.validateChallenge(
        [{ targetClaimId: 'claim_001', argument: 'Challenge based on invented data.', strength: 'low' }],
        ['3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
        { executionId: currentRunId, claimIds: ['claim_001'], evidenceIds: allowedIds },
      ),
    ).rejects.toThrow(/does not exist in database \(bear challenge\)/);
  });

  it('evidenceId Bear ada di DB tapi milik run lain ditolak', async () => {
    const otherRun = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
    const outsider = insertLegacyEvidenceFixture(db.raw, {
      runId: otherRun.id, ticker: 'BBRI', source: 'sectors.company_report', data: { roe: 20.3 },
    });
    await expect(
      validator.validateChallenge(
        [{ targetClaimId: 'claim_001', argument: 'Challenge based on another run data.', strength: 'low' }],
        [outsider.id],
        { executionId: currentRunId, claimIds: ['claim_001'], evidenceIds: allowedIds },
      ),
    ).rejects.toThrow(/does not exist in database \(bear challenge\)/);
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

describe('ClaimValidator — P1.1 Multi-Metric Reconciliation (singleMetric)', () => {
  it('flag undefined (backward-compat) saat pasangan metrik tak lengkap', async () => {
    const out = await validator.validate([validClaim], allowedIds, currentRunId); // company_report → tanpa pasangan
    expect(out[0].singleMetric).toBeUndefined();
  });

  it('set singleMetric=true saat claim hanya kutip sisi quarterly tapi cumulativeYtd tersedia', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const fin = insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.quarterly_financials',
      data: {
        quarters: [{ period: '2025-Q4', revenue: 100, netIncome: 20, revenueGrowthYoy: 18.2 }],
        cumulativeYtd: { periodLabel: 'H1 2026 vs H1 2025', revenueGrowthYoy: 5.1 },
      },
    });
    const ids = [fin.id];
    const claim: Claim = {
      ...validClaim,
      evidenceIds: ids,
      citedFigures: [{ evidenceId: fin.id, path: 'quarters[0].revenueGrowthYoy', value: 18.2, periodLabel: "Q4'25" }],
    };
    const out = await validator.validate([claim], ids, run.id);
    expect(out[0].singleMetric).toBe(true);
  });

  it('singleMetric=false saat claim kutip kedua sisi same family (quarterly + cumulativeYtd)', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const fin = insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.quarterly_financials',
      data: {
        quarters: [{ period: '2025-Q4', revenue: 100, netIncome: 20, revenueGrowthYoy: 18.2 }],
        cumulativeYtd: { periodLabel: 'H1 2026 vs H1 2025', revenueGrowthYoy: 5.1 },
      },
    });
    const ids = [fin.id];
    const claim: Claim = {
      ...validClaim,
      evidenceIds: ids,
      citedFigures: [
        { evidenceId: fin.id, path: 'quarters[0].revenueGrowthYoy', value: 18.2, periodLabel: "Q4'25" },
        { evidenceId: fin.id, path: 'cumulativeYtd.revenueGrowthYoy', value: 5.1, periodLabel: 'H1 2026 vs H1 2025' },
      ],
    };
    const out = await validator.validate([claim], ids, run.id);
    expect(out[0].singleMetric).toBeUndefined();
  });

  it('set singleMetric=true saat claim kutip distribution tapi aggregate juga tersedia', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const sent = insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.sentiment',
      data: { aggregate: 0.7, distribution: { positive: 0.7, negative: 0.1, neutral: 0.2 }, articleCount: 20 },
    });
    const ids = [sent.id];
    const claim: Claim = {
      ...validClaim,
      evidenceIds: ids,
      citedFigures: [{ evidenceId: sent.id, path: 'distribution.positive', value: 0.7, periodLabel: '30d' }],
    };
    const out = await validator.validate([claim], ids, run.id);
    expect(out[0].singleMetric).toBe(true);
  });

  it('set singleMetric=true saat claim hanya pakai satu dari dua foreign window yang tersedia', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const short = insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.foreign_flow',
      data: { window: '30d', netFlow: 'buy', netForeignPctOfCap: 0.8 },
    });
    const long = insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.foreign_flow',
      data: { window: '90d', netFlow: 'sell', netForeignPctOfCap: -0.4 },
    });
    const ids = [short.id, long.id];
    const claim: Claim = {
      ...validClaim,
      evidenceIds: [short.id],
      citedFigures: [{ evidenceId: short.id, path: 'netForeignPctOfCap', value: 0.8, periodLabel: '30d' }],
    };
    const out = await validator.validate([claim], ids, run.id);
    expect(out[0].singleMetric).toBe(true);
  });
});
