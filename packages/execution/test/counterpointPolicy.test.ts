import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BearProposalOutput } from '@harness/schemas';
import type { EvidenceStore } from '@harness/evidence';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { insertLegacyEvidenceFixture } from '../../database/test/helpers/legacyEvidenceFixture';
import { acceptedFinancialEvidence } from './helpers/acceptedFinancialEvidence';
import { CounterpointPolicy, COUNTERPOINT_POLICY_FINGERPRINT, COUNTERPOINT_POLICY_ID } from '../src/counterpointPolicy';

let db: FinharnessDatabase;
let dir: string;
let runId: string;
let evidenceId: string;
let secondEvidenceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-counterpoint-policy-'));
  db = openDb({ homeDir: dir });
  runId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
  evidenceId = insertLegacyEvidenceFixture(db.raw, {
    runId, ticker: 'BBCA', source: 'sectors.company_report',
    data: { multiple: 12.4, marginBps: 120, changePercent: -4.2, roe: 23.1 },
  }).id;
  secondEvidenceId = insertLegacyEvidenceFixture(db.raw, {
    runId, ticker: 'BBCA', source: 'sectors.quarterly_financials', data: { growth: 8.7 },
  }).id;
});

afterEach(() => { db.raw.close(); rmSync(dir, { recursive: true, force: true }); });

function baseProposal(changes: Partial<BearProposalOutput['counterpoints'][number]> = {}): BearProposalOutput {
  return {
    reasoning: 'The reporting window does not yet establish that the observed performance will persist.',
    evidenceIds: [evidenceId],
    counterpoints: [{
      targetClaimId: 'claim_1',
      argument: 'The valuation is 12.4x, leaving less room for execution risk.',
      strength: 'moderate',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The report records the valuation multiple.' }],
      citedFigures: [{ evidenceId, path: 'multiple', value: 12.4, periodLabel: 'FY 2025' }],
      ...changes,
    }],
  };
}

function ground(response = baseProposal(), options: {
  allowedEvidenceIds?: string[]; seenEvidenceIds?: string[]; allowedTargetClaimIds?: string[];
  sourceNodeId?: 'round-1-bear-challenge' | 'conditional-bear-rechallenge'; executionId?: string;
  evidenceStore?: EvidenceStore;
} = {}) {
  return new CounterpointPolicy(options.evidenceStore ?? db.evidence).ground({
    executionId: options.executionId ?? runId,
    sourceNodeId: options.sourceNodeId ?? 'round-1-bear-challenge',
    response,
    allowedEvidenceIds: options.allowedEvidenceIds ?? [evidenceId, secondEvidenceId],
    seenEvidenceIds: options.seenEvidenceIds ?? [evidenceId, secondEvidenceId],
    allowedTargetClaimIds: options.allowedTargetClaimIds ?? ['claim_1'],
  });
}

describe('Counterpoint Policy v2', () => {
  it('grounds Evidence, target, numeric assertions, source, and deterministic identity', async () => {
    const first = await ground();
    const retry = await ground();

    expect(first).toEqual(retry);
    expect(first[0]).toMatchObject({
      counterpointId: 'counterpoint:round-1-bear-challenge:1',
      sourceNodeId: 'round-1-bear-challenge',
      policyId: COUNTERPOINT_POLICY_ID,
      policyFingerprint: COUNTERPOINT_POLICY_FINGERPRINT,
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies' }],
      citedFigures: [{ evidenceId, path: 'multiple', value: 12.4 }],
    });
  });

  it('rejects a current financial Counterpoint that names a different metric with the same value', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const currentEvidence = acceptedFinancialEvidence({
      id, runId, kind: 'company_report', data: {
        ticker: 'BBCA', asOf: '2025-12-31',
        financials: { roe: 23.1, roa: 5, netMargin: 10, grossMargin: 30, debtToEquity: 1, currentRatio: 1.5,
          yoyQuarterRevenueGrowth: 8, yoyQuarterEarningsGrowth: 4 },
        valuation: { price: 100, pe: 12, pb: 2, dividendYield: 3 },
      },
    });
    const store = { getManyByIdsForRun: async (_runId: string, ids: string[]) => ids.includes(id) ? [currentEvidence] : [] } as unknown as EvidenceStore;
    const response = baseProposal({
      argument: 'Revenue growth reached 23.1%.',
      evidenceIds: [id],
      evidenceLinks: [{ evidenceId: id, relation: 'qualifies', rationale: 'The report gives ROE.' }],
      citedFigures: [{ evidenceId: id, path: 'financials.roe', value: 23.1, periodLabel: '2025-12-31' }],
    });
    response.evidenceIds = [id];
    await expect(ground(response, { allowedEvidenceIds: [id], seenEvidenceIds: [id], evidenceStore: store }))
      .rejects.toThrow(/metric|financial|statement/i);
  });

  it('accepts a current financial Counterpoint when the metric, value, and unit match', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const currentEvidence = acceptedFinancialEvidence({
      id, runId, kind: 'company_report', data: {
        ticker: 'BBCA', asOf: '2025-12-31',
        financials: { roe: 23.1, roa: 5, netMargin: 10, grossMargin: 30, debtToEquity: 1, currentRatio: 1.5,
          yoyQuarterRevenueGrowth: 8, yoyQuarterEarningsGrowth: 4 },
        valuation: { price: 100, pe: 12, pb: 2, dividendYield: 3 },
      },
    });
    const store = { getManyByIdsForRun: async (_runId: string, ids: string[]) => ids.includes(id) ? [currentEvidence] : [] } as unknown as EvidenceStore;
    const response = baseProposal({
      argument: 'ROE reached 23.1%.',
      evidenceIds: [id],
      evidenceLinks: [{ evidenceId: id, relation: 'qualifies', rationale: 'The report gives ROE.' }],
      citedFigures: [{ evidenceId: id, path: 'financials.roe', value: 23.1, periodLabel: '2025-12-31' }],
    });
    response.evidenceIds = [id];
    await expect(ground(response, { allowedEvidenceIds: [id], seenEvidenceIds: [id], evidenceStore: store }))
      .resolves.toHaveLength(1);
  });

  it('preserves numeric grounding for current financial Evidence outside semantic scope', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const currentEvidence = acceptedFinancialEvidence({ id, runId, kind: 'daily_transaction', data: { price: 23.1 } });
    const store = { getManyByIdsForRun: async (_runId: string, ids: string[]) => ids.includes(id) ? [currentEvidence] : [] } as unknown as EvidenceStore;
    const response = baseProposal({
      argument: 'ROE reached 23.1%.',
      evidenceIds: [id],
      evidenceLinks: [{ evidenceId: id, relation: 'qualifies', rationale: 'The accepted observation has the value.' }],
      citedFigures: [{ evidenceId: id, path: 'price', value: 23.1, periodLabel: '2025-12-31' }],
    });
    response.evidenceIds = [id];
    await expect(ground(response, { allowedEvidenceIds: [id], seenEvidenceIds: [id], evidenceStore: store })).resolves.toHaveLength(1);
  });

  it('composes supported semantic and outside-scope numeric grounding in one Counterpoint', async () => {
    const semanticId = '11111111-1111-4111-8111-111111111111';
    const outsideId = '22222222-2222-4222-8222-222222222222';
    const semanticEvidence = acceptedFinancialEvidence({
      id: semanticId, runId, kind: 'company_report', data: {
        ticker: 'BBCA', asOf: '2025-12-31', financials: { roe: 22.4 }, valuation: {},
      },
    });
    const outsideEvidence = acceptedFinancialEvidence({ id: outsideId, runId, kind: 'daily_transaction', data: { upDaysPct: 60 } });
    const store = { getManyByIdsForRun: async () => [semanticEvidence, outsideEvidence] } as unknown as EvidenceStore;
    const response = baseProposal({
      argument: 'ROE was 22.4%, while up days were 60%.',
      evidenceIds: [semanticId, outsideId],
      evidenceLinks: [
        { evidenceId: semanticId, relation: 'qualifies', rationale: 'The report provides ROE.' },
        { evidenceId: outsideId, relation: 'qualifies', rationale: 'The daily observation provides up days.' },
      ],
      citedFigures: [
        { evidenceId: semanticId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' },
        { evidenceId: outsideId, path: 'upDaysPct', value: 60, periodLabel: '2025-12-31' },
      ],
    });
    response.evidenceIds = [semanticId, outsideId];
    await expect(ground(response, { allowedEvidenceIds: [semanticId, outsideId], seenEvidenceIds: [semanticId, outsideId], evidenceStore: store }))
      .resolves.toHaveLength(1);
  });

  it('does not let an outside-scope same-number figure rescue a semantic mismatch', async () => {
    const semanticId = '11111111-1111-4111-8111-111111111111';
    const outsideId = '22222222-2222-4222-8222-222222222222';
    const semanticEvidence = acceptedFinancialEvidence({
      id: semanticId, runId, kind: 'company_report', data: {
        ticker: 'BBCA', asOf: '2025-12-31', financials: { roe: 22.4, yoyQuarterRevenueGrowth: 8 }, valuation: {},
      },
    });
    const outsideEvidence = acceptedFinancialEvidence({ id: outsideId, runId, kind: 'daily_transaction', data: { upDaysPct: 22.4 } });
    const store = { getManyByIdsForRun: async () => [semanticEvidence, outsideEvidence] } as unknown as EvidenceStore;
    const response = baseProposal({
      argument: 'Revenue growth was 22.4%, while up days were 22.4%.',
      evidenceIds: [semanticId, outsideId],
      evidenceLinks: [
        { evidenceId: semanticId, relation: 'qualifies', rationale: 'The report provides ROE.' },
        { evidenceId: outsideId, relation: 'qualifies', rationale: 'The daily observation provides up days.' },
      ],
      citedFigures: [
        { evidenceId: semanticId, path: 'financials.roe', value: 22.4, periodLabel: '2025-12-31' },
        { evidenceId: outsideId, path: 'upDaysPct', value: 22.4, periodLabel: '2025-12-31' },
      ],
    });
    response.evidenceIds = [semanticId, outsideId];
    await expect(ground(response, { allowedEvidenceIds: [semanticId, outsideId], seenEvidenceIds: [semanticId, outsideId], evidenceStore: store }))
      .rejects.toThrow(/financial argument/i);
  });

  it('accepts supported bps and negative percentage figures', async () => {
    for (const [argument, path, value] of [
      ['margin pressure widened 120 bps', 'marginBps', 120],
      ['performance fell -4.2%', 'changePercent', -4.2],
    ] as const) {
      await expect(ground(baseProposal({
        argument,
        citedFigures: [{ evidenceId, path, value, periodLabel: 'FY 2025' }],
      }))).resolves.toHaveLength(1);
    }
  });

  it('does not treat period-only digits as metric assertions', async () => {
    await expect(ground(baseProposal({
      argument: 'Performance weakened in Q2 2026 and remained uneven through H1 2025.',
      citedFigures: undefined,
    }))).resolves.toHaveLength(1);
  });

  it('rejects duplicate Counterpoint Evidence IDs', async () => {
    await expect(ground(baseProposal({ evidenceIds: [evidenceId, evidenceId] }))).rejects.toThrow(/duplicate.*Evidence/i);
  });

  it.each([
    ['duplicate links', [{ evidenceId, relation: 'qualifies' as const, rationale: 'First link.' }, { evidenceId, relation: 'supports' as const, rationale: 'Duplicate link.' }]],
    ['missing link', []],
    ['extra link', [{ evidenceId, relation: 'qualifies' as const, rationale: 'Matching link.' }, { evidenceId: secondEvidenceId, relation: 'supports' as const, rationale: 'Unlisted Evidence.' }]],
  ])('rejects %s', async (_name, evidenceLinks) => {
    await expect(ground(baseProposal({ evidenceLinks } as Partial<BearProposalOutput['counterpoints'][number]>))).rejects.toThrow(/link|Evidence/i);
  });

  it('rejects a CitedFigure that is not linked by its Counterpoint', async () => {
    await expect(ground(baseProposal({
      evidenceIds: [secondEvidenceId],
      evidenceLinks: [{ evidenceId: secondEvidenceId, relation: 'qualifies', rationale: 'Quarterly data.' }],
    }))).rejects.toThrow(/figure|linked/i);
  });

  it('requires each Counterpoint Evidence ID to be covered by the Bear response', async () => {
    const response = baseProposal();
    response.evidenceIds = [];
    await expect(ground(response)).rejects.toThrow(/response|cover/i);
  });

  it('rejects unseen and unallowed Evidence', async () => {
    await expect(ground(baseProposal(), { seenEvidenceIds: [secondEvidenceId] })).rejects.toThrow(/seen|never/i);
    await expect(ground(baseProposal(), { allowedEvidenceIds: [secondEvidenceId] })).rejects.toThrow(/allowed/i);
  });

  it('rejects Evidence that belongs to another Execution', async () => {
    const otherRunId = (await db.execution.createRun({ ticker: 'BBCA', command: 'judge' })).id;
    const outsiderId = insertLegacyEvidenceFixture(db.raw, {
      runId: otherRunId, ticker: 'BBCA', source: 'sectors.company_report', data: { multiple: 12.4 },
    }).id;
    const response = baseProposal({
      evidenceIds: [outsiderId],
      evidenceLinks: [{ evidenceId: outsiderId, relation: 'qualifies', rationale: 'Other execution.' }],
      citedFigures: [{ evidenceId: outsiderId, path: 'multiple', value: 12.4, periodLabel: 'FY 2025' }],
    });
    response.evidenceIds = [outsiderId];

    await expect(ground(response, { allowedEvidenceIds: [outsiderId], seenEvidenceIds: [outsiderId] }))
      .rejects.toThrow(/execution|membership|scope/i);
  });

  it('rejects unknown targets and non-Bear source nodes', async () => {
    await expect(ground(baseProposal({ targetClaimId: 'unknown' }))).rejects.toThrow(/target|claim/i);
    await expect(ground(baseProposal(), { sourceNodeId: 'round-1-bull-thesis' as never }))
      .rejects.toThrow(/sourceNodeId|source node/i);
  });

  it('requires a CitedFigure for numeric assertions and grounds the argument, figure, and Evidence value together', async () => {
    await expect(ground(baseProposal({ citedFigures: undefined }))).rejects.toThrow(/figure|numeric/i);
    await expect(ground(baseProposal({
      argument: 'The valuation is 99%, which is unsustainable.',
      citedFigures: [{ evidenceId, path: 'roe', value: 23.1, periodLabel: 'FY 2025' }],
    }))).rejects.toThrow(/numeric|statement|figure/i);
  });
});
