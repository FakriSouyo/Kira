import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { ClaimPolicy, CLAIM_POLICY_FINGERPRINT, CLAIM_POLICY_ID } from '@harness/execution';
import type { BullProposalOutput } from '@harness/schemas';
import { insertLegacyEvidenceFixture } from '../../database/test/helpers/legacyEvidenceFixture';

let db: FinharnessDatabase;
let dir: string;
let runId: string;
let evidenceId: string;
let secondId: string;
let proposal: BullProposalOutput;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-claim-policy-'));
  db = openDb({ homeDir: dir });
  runId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
  evidenceId = insertLegacyEvidenceFixture(db.raw, { runId, ticker: 'BBCA', source: 'sectors.company_report', data: { roe: 23.1, multiple: 12.4, marginBps: 120 } }).id;
  secondId = insertLegacyEvidenceFixture(db.raw, { runId, ticker: 'BBCA', source: 'sectors.quarterly_financials', data: { growth: 8.7 } }).id;
  proposal = {
    reasoning: 'The company report supports the measured profitability assessment.',
    evidenceIds: [evidenceId, secondId],
    claims: [{
      claimId: 'claim_1', statement: 'ROE reached 23.1%', confidence: 'strong',
      reasoning: 'The reported ROE supports a strong profitability assessment.',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'The company report provides the ROE value.' }],
      citedFigures: [{ evidenceId, path: 'roe', value: 23.1, periodLabel: 'FY 2025' }],
    }],
  };
});

afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

function ground(response = proposal, allowedEvidenceIds = [evidenceId, secondId], seenEvidenceIds = [evidenceId, secondId]) {
  return new ClaimPolicy(db.evidence).ground({ executionId: runId, response, allowedEvidenceIds, seenEvidenceIds });
}

describe('Claim Policy v1', () => {
  it('grounds a numeric proposal, preserves explicit links, and owns deterministic annotation', async () => {
    const [claim] = await ground();
    expect(claim).toMatchObject({
      policyId: CLAIM_POLICY_ID, policyFingerprint: CLAIM_POLICY_FINGERPRINT,
      evidenceLinks: proposal.claims[0]!.evidenceLinks, citedFigures: proposal.claims[0]!.citedFigures,
    });
    expect(claim.singleMetric).toBeUndefined();
  });

  it.each([
    ['missing link', { evidenceLinks: [] }],
    ['extra link', { evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'Reported ROE.' }, { evidenceId: secondId, relation: 'qualifies', rationale: 'A second data point.' }] }],
    ['duplicate link', { evidenceLinks: [{ evidenceId, relation: 'supports', rationale: 'Reported ROE.' }, { evidenceId, relation: 'contradicts', rationale: 'Contradictory assertion.' }] }],
    ['unlinked figure', { evidenceIds: [secondId] }],
  ] as const)('rejects %s', async (_name, change) => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, ...change }] } as unknown as BullProposalOutput)).rejects.toThrow();
  });

  it('rejects duplicate Claim Evidence IDs even when the unique link set matches', async () => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, evidenceIds: [evidenceId, evidenceId] }] }))
      .rejects.toThrow(/duplicate Evidence IDs/i);
  });

  it('rejects Evidence from another execution even if allowed and seen', async () => {
    const other = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
    const outsider = insertLegacyEvidenceFixture(db.raw, { runId: other, ticker: 'BBCA', source: 'sectors.company_report', data: { roe: 23.1 } }).id;
    const response = { ...proposal, evidenceIds: [outsider], claims: [{ ...proposal.claims[0]!, evidenceIds: [outsider], evidenceLinks: [{ evidenceId: outsider, relation: 'supports' as const, rationale: 'Other run data.' }], citedFigures: [{ evidenceId: outsider, path: 'roe', value: 23.1, periodLabel: 'FY 2025' }] }] };
    await expect(ground(response, [outsider], [outsider])).rejects.toThrow(/execution|membership|scope/i);
  });

  it('rejects unallowed, unseen, and uncovered response Evidence', async () => {
    await expect(ground(proposal, [secondId])).rejects.toThrow(/allowed/i);
    await expect(ground(proposal, [evidenceId, secondId], [secondId])).rejects.toThrow(/seen|never saw/i);
    await expect(ground({ ...proposal, evidenceIds: [secondId] })).rejects.toThrow(/response|cover/i);
  });

  it.each([
    ['ROE reached 99%', 23.1],
    ['valuation is 12.4x', 23.1],
    ['margin expanded 120 bps', 23.1],
  ])('rejects statement/figure mismatch: %s', async (statement, value) => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, statement, citedFigures: [{ evidenceId, path: 'roe', value, periodLabel: 'FY 2025' }] }] })).rejects.toThrow(/statement|numeric|figure/i);
  });

  it('rejects a quantitative statement without a CitedFigure', async () => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, citedFigures: undefined }] })).rejects.toThrow(/figure|numeric/i);
  });

  it.each([
    ['valuation is 12.4x', 'multiple', 12.4],
    ['margin expanded 120 bps', 'marginBps', 120],
  ])('accepts supported quantitative form: %s', async (statement, path, value) => {
    const [claim] = await ground({ ...proposal, claims: [{ ...proposal.claims[0]!, statement, citedFigures: [{ evidenceId, path, value, periodLabel: 'FY 2025' }] }] });
    expect(claim.citedFigures?.[0]?.value).toBe(value);
  });

  it('grounds a negative signed percentage literal', async () => {
    const negativeId = insertLegacyEvidenceFixture(db.raw, { runId, ticker: 'BBCA', source: 'sectors.company_report', data: { roe: -4.2 } }).id;
    const response: BullProposalOutput = {
      ...proposal, evidenceIds: [negativeId], claims: [{ ...proposal.claims[0]!, statement: 'ROE reached -4.2%',
        evidenceIds: [negativeId],
        evidenceLinks: [{ evidenceId: negativeId, relation: 'supports', rationale: 'The report records the negative ROE value.' }],
        citedFigures: [{ evidenceId: negativeId, path: 'roe', value: -4.2, periodLabel: 'FY 2025' }],
      }],
    };
    const [claim] = await ground(response, [negativeId], [negativeId]);
    expect(claim.statement).toBe('ROE reached -4.2%');
    expect(claim.citedFigures?.[0]?.value).toBe(-4.2);
  });

  it.each(['performance improved in Q2 2026', 'H1 2026 improved from H1 2025'])('ignores period-only digits: %s', async statement => {
    const [claim] = await ground({ ...proposal, claims: [{ ...proposal.claims[0]!, statement, citedFigures: undefined }] });
    expect(claim.statement).toBe(statement);
  });

  it('rejects a missing Evidence path and an Evidence value mismatch', async () => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, citedFigures: [{ evidenceId, path: 'missing', value: 23.1, periodLabel: 'FY 2025' }] }] })).rejects.toThrow(/path/i);
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, citedFigures: [{ evidenceId, path: 'roe', value: 24, periodLabel: 'FY 2025' }] }] })).rejects.toThrow(/mismatch|value/i);
  });

  it('keeps the statement within tolerance of actual Evidence, not just the intermediate figure', async () => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, statement: 'ROE reached 23.9%',
      citedFigures: [{ evidenceId, path: 'roe', value: 23.5, periodLabel: 'FY 2025' }] }] }))
      .rejects.toThrow(/statement|numeric|Evidence/i);
  });

  it('rejects model-owned singleMetric', async () => {
    await expect(ground({ ...proposal, claims: [{ ...proposal.claims[0]!, singleMetric: false }] } as unknown as BullProposalOutput)).rejects.toThrow();
  });

  it('derives singleMetric from seen paired financial metrics', async () => {
    const pairedId = insertLegacyEvidenceFixture(db.raw, { runId, ticker: 'BBCA', source: 'sectors.paired_financials',
      data: { quarters: [{ revenueGrowthYoy: 18.2 }], cumulativeYtd: { revenueGrowthYoy: 5.1 } } }).id;
    const response: BullProposalOutput = { ...proposal, evidenceIds: [pairedId], claims: [{ ...proposal.claims[0]!,
      statement: 'Revenue growth reached 18.2%', evidenceIds: [pairedId],
      evidenceLinks: [{ evidenceId: pairedId, relation: 'supports', rationale: 'Quarterly revenue growth is reported.' }],
      citedFigures: [{ evidenceId: pairedId, path: 'quarters[0].revenueGrowthYoy', value: 18.2, periodLabel: 'Q2 2026' }],
    }] };
    const [claim] = await ground(response, [pairedId], [pairedId]);
    expect(claim.singleMetric).toBe(true);
  });
});
