import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CounterpointPolicy,
  COUNTERPOINT_POLICY_FINGERPRINT,
  COUNTERPOINT_POLICY_ID,
  ClaimPolicy,
} from '@harness/execution';
import type { BearProposalOutput, GroundedCounterpoint } from '@harness/schemas';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

let db: FinharnessDatabase;
let dir: string;
let runId: string;
let evidenceId: string;
let secondEvidenceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-counterpoint-store-'));
  db = openDb({ homeDir: dir });
  runId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
  evidenceId = insertLegacyEvidenceFixture(db.raw, {
    runId, ticker: 'BBCA', source: 'sectors.company_report', data: { multiple: 12.4, roe: 23.1 },
  }).id;
  secondEvidenceId = insertLegacyEvidenceFixture(db.raw, {
    runId, ticker: 'BBCA', source: 'sectors.quarterly_financials', data: { growth: 8.7 },
  }).id;
});

afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

async function saveTargetClaim(run = runId, id = 'claim_1', evidence = evidenceId): Promise<void> {
  const [claim] = await new ClaimPolicy(db.evidence).ground({
    executionId: run,
    allowedEvidenceIds: [evidence],
    seenEvidenceIds: [evidence],
    response: {
      reasoning: 'The company report supports the profitability claim with a measured financial result.',
      evidenceIds: [evidence],
      claims: [{
        claimId: id,
        statement: 'Profitability supports the constructive thesis.',
        confidence: 'moderate',
        reasoning: 'The report supplies a concrete financial result for the claim.',
        evidenceIds: [evidence],
        evidenceLinks: [{ evidenceId: evidence, relation: 'supports', rationale: 'The report records this financial result.' }],
      }],
    },
  });
  await db.claims.save({ runId: run, messageId: `bull_${run}`, claim: claim! });
}

function proposal(targetClaimId = 'claim_1', changes: Partial<BearProposalOutput['counterpoints'][number]> = {}): BearProposalOutput {
  return {
    reasoning: 'The reporting window does not yet establish that the observed performance will persist.',
    evidenceIds: [evidenceId],
    counterpoints: [{
      targetClaimId,
      argument: 'The valuation is 12.4x, leaving less room for execution risk.',
      strength: 'moderate',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The report records the valuation multiple.' }],
      citedFigures: [{ evidenceId, path: 'multiple', value: 12.4, periodLabel: 'FY 2025' }],
      ...changes,
    }],
  };
}

async function grounded(input = proposal(), sourceNodeId: 'round-1-bear-challenge' | 'conditional-bear-rechallenge' = 'round-1-bear-challenge') {
  return (await new CounterpointPolicy(db.evidence).ground({
    executionId: runId, sourceNodeId, response: input,
    allowedEvidenceIds: [evidenceId, secondEvidenceId], seenEvidenceIds: [evidenceId, secondEvidenceId],
    allowedTargetClaimIds: [input.counterpoints[0]!.targetClaimId],
  }))[0]!;
}

describe('canonical Counterpoint persistence', () => {
  beforeEach(async () => { await saveTargetClaim(); });

  it('round-trips full grounding identically through CounterpointStore and ExecutionStore', async () => {
    const counterpoint = await grounded();
    const stored = await db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint });

    expect(stored).toMatchObject({
      runId, messageId: 'bear_1', counterpointId: counterpoint.counterpointId,
      sourceNodeId: 'round-1-bear-challenge', targetClaimId: 'claim_1',
      evidenceIds: [evidenceId], evidenceLinks: counterpoint.evidenceLinks,
      citedFigures: counterpoint.citedFigures, policyId: COUNTERPOINT_POLICY_ID,
      policyFingerprint: COUNTERPOINT_POLICY_FINGERPRINT,
    });
    expect((await db.counterpoints.getByRun(runId))[0]).toEqual(stored);
    expect((await db.execution.getExecutionWithArtifacts(runId)).counterpoints).toEqual(await db.counterpoints.getByRun(runId));
  });

  it('is idempotent for an identical grounded retry and rejects semantic conflicts', async () => {
    const counterpoint = await grounded();
    const first = await db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint });
    const retry = await db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint });
    expect(retry.id).toBe(first.id);

    const changedEvidenceProposal = proposal('claim_1', {
      argument: 'The latest report leaves a meaningful durability risk unresolved.',
      evidenceIds: [secondEvidenceId],
      evidenceLinks: [{ evidenceId: secondEvidenceId, relation: 'qualifies', rationale: 'The quarterly report is qualified context.' }],
      citedFigures: undefined,
    });
    changedEvidenceProposal.evidenceIds = [secondEvidenceId];
    const changedEvidence = await grounded(changedEvidenceProposal);
    const changes: Array<GroundedCounterpoint> = [
      { ...counterpoint, argument: 'The latest report leaves a meaningful durability risk unresolved.', citedFigures: undefined },
      { ...counterpoint, targetClaimId: 'claim_2' },
      { ...counterpoint, strength: 'high' },
      changedEvidence,
      { ...counterpoint, citedFigures: [{ evidenceId, path: 'multiple', value: 12.4, periodLabel: 'FY 2024' }] },
      { ...counterpoint, evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'Changed producer assertion.' }] },
      { ...counterpoint, sourceNodeId: 'conditional-bear-rechallenge' },
    ];
    await saveTargetClaim(runId, 'claim_2');
    for (const changed of changes) {
      await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: changed }))
        .rejects.toThrow(/identity conflict|policy|counterpoint/i);
    }
  });

  it.each([
    ['duplicate Evidence IDs', (point: GroundedCounterpoint) => ({ ...point, evidenceIds: [evidenceId, evidenceId] })],
    ['duplicate Evidence links', (point: GroundedCounterpoint) => ({ ...point, evidenceLinks: [
      ...point.evidenceLinks, { ...point.evidenceLinks[0]!, relation: 'supports' as const },
    ] })],
    ['missing Evidence link', (point: GroundedCounterpoint) => ({ ...point, evidenceLinks: [] })],
    ['unlinked CitedFigure', (point: GroundedCounterpoint) => ({ ...point, evidenceIds: [secondEvidenceId], evidenceLinks: [
      { evidenceId: secondEvidenceId, relation: 'qualifies' as const, rationale: 'Quarterly context.' },
    ] })],
  ])('independently rejects %s at the store boundary', async (_name, change) => {
    const counterpoint = await grounded();
    await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: change(counterpoint) as GroundedCounterpoint }))
      .rejects.toThrow(/Evidence|link|figure/i);
  });

  it('rejects wrong or missing current Policy identity', async () => {
    const counterpoint = await grounded();
    await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: { ...counterpoint, policyId: 'counterpoint-policy-v2' } }))
      .rejects.toThrow(/policy/i);
    await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: { ...counterpoint, policyFingerprint: `${COUNTERPOINT_POLICY_FINGERPRINT}x` } }))
      .rejects.toThrow(/policy/i);
    await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: { ...counterpoint, policyId: undefined } as never }))
      .rejects.toThrow(/policy|ground/i);
  });

  it('requires target Claim and Evidence membership in the same Execution', async () => {
    const otherRunId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
    const otherEvidenceId = insertLegacyEvidenceFixture(db.raw, {
      runId: otherRunId, ticker: 'BBCA', source: 'sectors.company_report', data: { multiple: 12.4 },
    }).id;
    await saveTargetClaim(otherRunId, 'claim_foreign', otherEvidenceId);

    const foreignTarget = await grounded(proposal('claim_foreign'));
    await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: foreignTarget }))
      .rejects.toThrow(/target|Claim|Execution/i);

    const foreignProposal = proposal('claim_1', {
      argument: 'The available foreign report leaves persistence uncertain.',
      evidenceIds: [otherEvidenceId],
      evidenceLinks: [{ evidenceId: otherEvidenceId, relation: 'qualifies', rationale: 'The foreign report qualifies this point.' }],
      citedFigures: undefined,
    });
    foreignProposal.evidenceIds = [otherEvidenceId];
    const foreignEvidence = (await new CounterpointPolicy(db.evidence).ground({
      executionId: otherRunId,
      sourceNodeId: 'round-1-bear-challenge',
      response: foreignProposal,
      allowedEvidenceIds: [otherEvidenceId],
      seenEvidenceIds: [otherEvidenceId],
      allowedTargetClaimIds: ['claim_1'],
    }))[0]!;
    await expect(db.counterpoints.save({ runId, messageId: 'bear_1', counterpoint: foreignEvidence }))
      .rejects.toThrow(/Evidence|Execution|membership/i);
  });

  it('fails closed when a durable current row has corrupt grounding metadata', async () => {
    db.raw.prepare(`INSERT INTO counterpoints
      (id, run_id, message_id, counterpoint_id, source_node_id, target_claim_id, argument, strength, evidence_ids, cited_figures, evidence_links, policy_id, policy_fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), runId, 'bear_1', 'cp_corrupt', 'round-1-bear-challenge', 'claim_1',
        'A malformed current counterpoint.', 'moderate', JSON.stringify([evidenceId]), null, 'null',
        COUNTERPOINT_POLICY_ID, COUNTERPOINT_POLICY_FINGERPRINT, new Date().toISOString());

    await expect(db.counterpoints.getByRun(runId)).rejects.toThrow(/grounding|corrupt|metadata|array/i);
  });
});
