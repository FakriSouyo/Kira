import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaimPolicy, CLAIM_POLICY_FINGERPRINT, CLAIM_POLICY_ID } from '@harness/execution';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

let db: FinharnessDatabase;
let dir: string;
let runId: string;
let evidenceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-claim-durable-'));
  db = openDb({ homeDir: dir });
  runId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
  evidenceId = insertLegacyEvidenceFixture(db.raw, { runId, ticker: 'BBCA', source: 'sectors.company_report',
    data: { roe: 23.1, quarters: [{ revenueGrowthYoy: 18.2 }], cumulativeYtd: { revenueGrowthYoy: 5.1 } } }).id;
});
afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

async function grounded() {
  const [claim] = await new ClaimPolicy(db.evidence).ground({
    executionId: runId, allowedEvidenceIds: [evidenceId], seenEvidenceIds: [evidenceId],
    response: {
      reasoning: 'The company report provides a clear profitability signal.', evidenceIds: [evidenceId],
      claims: [{ claimId: 'claim_1', statement: 'Revenue growth reached 18.2%', confidence: 'strong',
        reasoning: 'Quarterly revenue growth supports the thesis, with cumulative comparison still relevant.',
        evidenceIds: [evidenceId],
        evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'The report directly records quarterly revenue growth.' }],
        citedFigures: [{ evidenceId, path: 'quarters[0].revenueGrowthYoy', value: 18.2, periodLabel: 'Q2 2026' }],
      }],
    },
  });
  return claim;
}

describe('canonical Claim grounding persistence', () => {
  it('round-trips full grounding through ClaimStore and ExecutionStore', async () => {
    const claim = await grounded();
    expect(claim.singleMetric).toBe(true);
    await db.claims.save({ runId, messageId: 'bull_1', claim });
    for (const stored of [
      (await db.claims.getByRun(runId))[0]!,
      (await db.execution.getExecutionWithArtifacts(runId)).claims[0]!,
    ]) {
      expect(stored).toMatchObject({
        citedFigures: claim.citedFigures,
        evidenceLinks: claim.evidenceLinks, policyId: CLAIM_POLICY_ID,
        policyFingerprint: claim.policyFingerprint,
      });
      expect(stored.singleMetric).toBe(claim.singleMetric);
    }
  });

  it('is idempotent for identical current Claims and rejects every grounding conflict', async () => {
    const claim = await grounded();
    const first = await db.claims.save({ runId, messageId: 'bull_1', claim });
    const second = await db.claims.save({ runId, messageId: 'bull_1', claim });
    expect(second.id).toBe(first.id);
    for (const changed of [
      { ...claim, statement: 'ROE reached 24.1%' },
      { ...claim, evidenceLinks: [{ evidenceId, relation: 'qualifies' as const, rationale: 'Different relationship.' }] },
      { ...claim, citedFigures: [{ evidenceId, path: 'roe', value: 23.2, periodLabel: 'FY 2025' }] },
      { ...claim, singleMetric: false },
    ]) {
      await expect(db.claims.save({ runId, messageId: 'bull_1', claim: changed })).rejects.toThrow(/immutable identity conflict/);
    }
  });

  it('rejects duplicate Claim Evidence IDs at the current persistence boundary', async () => {
    const claim = await grounded();
    const duplicated = { ...claim, evidenceIds: [evidenceId, evidenceId] };
    await expect(db.claims.save({ runId, messageId: 'bull_1', claim: duplicated }))
      .rejects.toThrow(/duplicate Evidence IDs/i);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM claims WHERE run_id = ?').get(runId)).toEqual({ count: 0 });
  });

  it('reads a historical Claim without inventing T2 metadata', async () => {
    db.raw.prepare(`INSERT INTO claims (id, run_id, message_id, claim_id, statement, confidence, reasoning, evidence_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), runId, 'bull_1', 'legacy_1',
      'Historical profitability was strong.', 'strong', 'The old checkpoint predates T2.', JSON.stringify([evidenceId]));
    const stored = (await db.claims.getByRun(runId))[0]!;
    expect(stored).toMatchObject({ claimId: 'legacy_1', evidenceIds: [evidenceId] });
    expect(stored.policyId).toBeUndefined();
    expect(stored.evidenceLinks).toBeUndefined();
    expect(stored.citedFigures).toBeUndefined();
    expect(stored.singleMetric).toBeUndefined();
  });

  it('rejects missing or mismatched policy identity on current writes', async () => {
    const claim = await grounded();
    await expect(db.claims.save({ runId, messageId: 'bull_1', claim: { ...claim, policyId: undefined } as never })).rejects.toThrow(/policy|ground/i);
    await expect(db.claims.save({ runId, messageId: 'bull_1', claim: { ...claim, policyId: 'claim-policy-v999' } as never }))
      .rejects.toThrow(/policy|ground/i);
    await expect(db.claims.save({ runId, messageId: 'bull_1', claim: { ...claim, policyFingerprint: `${CLAIM_POLICY_FINGERPRINT}wrong` } as never }))
      .rejects.toThrow(/policy|ground/i);
  });

  it('rejects partial T2 metadata on read', async () => {
    await grounded();
    db.raw.prepare(`INSERT INTO claims (id, run_id, message_id, claim_id, statement, confidence, reasoning, evidence_ids, policy_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), runId, 'bull_1', 'corrupt_1',
      'Historical profitability was strong.', 'strong', 'This row has partial policy metadata.', JSON.stringify([evidenceId]), CLAIM_POLICY_ID);
    await expect(db.claims.getByRun(runId)).rejects.toThrow(/partial|corrupt/i);
  });

  it('does not attach a grounded Claim to a different Execution', async () => {
    const claim = await grounded();
    const otherRun = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
    await expect(db.claims.save({ runId: otherRun, messageId: 'bull_other', claim }))
      .rejects.toThrow(/Execution|membership|scope/i);
  });
});
