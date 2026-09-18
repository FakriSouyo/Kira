import { describe, expect, it } from 'vitest';
import type { BearCounterpoint, Claim, Evidence } from '@harness/schemas';
import { createContextSnapshot } from '../src/snapshot.js';
import {
  assembleSpecialistContext,
  renderSpecialistContext,
} from '../src/specialist.js';

const EVIDENCE_A = '11111111-1111-4111-8111-111111111111';
const EVIDENCE_B = '22222222-2222-4222-8222-222222222222';

const evidence: Evidence[] = [
  {
    id: EVIDENCE_A, runId: 'execution-1', ticker: 'BBCA', source: 'sectors.company_report',
    sourceType: 'api', contentHash: 'hash-a', retrievedAt: '2026-09-18T00:00:00.000Z',
    data: { financials: { roe: 18.4 } },
  },
  {
    id: EVIDENCE_B, runId: 'execution-1', ticker: 'BBCA', source: 'sectors.quarterly_financials',
    sourceType: 'api', contentHash: 'hash-b', retrievedAt: '2026-09-18T00:00:00.000Z',
    data: { quarters: [{ period: 'Q2 2026', revenueGrowthYoy: 12.7 }] },
  },
];

const bullClaim: Claim = {
  claimId: 'claim-1', statement: 'Profitability supports the constructive thesis.', confidence: 'strong',
  reasoning: 'The cited company report provides the supporting profitability observation.', evidenceIds: [EVIDENCE_A],
};

const bearCounterpoint: BearCounterpoint = {
  targetClaimId: 'claim-1', argument: 'The observation may not establish durability.', strength: 'moderate',
};

const common = {
  sessionId: 'session-1', turnId: 'turn-1', executionId: 'execution-1', ticker: 'BBCA', roundNumber: 1,
  evidence,
};

describe('specialist context contracts', () => {
  it('assembles a Bull thesis context with only authoritative evidence', () => {
    const context = assembleSpecialistContext({ ...common, role: 'BULL', phase: 'THESIS' });
    const rendered = renderSpecialistContext(context);

    expect(context.contextKind).toBe('SPECIALIST');
    expect(context.specialist.role).toBe('BULL');
    expect(context.specialist.phase).toBe('THESIS');
    expect(context.specialist.evidenceIds).toEqual([EVIDENCE_A, EVIDENCE_B]);
    expect(rendered.evidenceZone).toContain(`Evidence ID: ${EVIDENCE_A}`);
    expect(rendered.evidenceZone).toBe(renderSpecialistContext(assembleSpecialistContext({ ...common, role: 'BULL', phase: 'THESIS' })).evidenceZone);
    expect(rendered.roleZone).not.toContain('Bear challenge');
    expect(rendered.roleZone).not.toContain('Judge evaluation');
  });

  it('assembles Bear, rebuttal, and Judge contexts from explicit typed upstream outputs', () => {
    const bear = assembleSpecialistContext({ ...common, role: 'BEAR', phase: 'CHALLENGE', bullClaims: [bullClaim] });
    const rebuttal = assembleSpecialistContext({
      ...common, role: 'BULL', phase: 'REBUTTAL', bullClaims: [bullClaim], bearCounterpoints: [bearCounterpoint],
    });
    const judge = assembleSpecialistContext({
      ...common, role: 'JUDGE', phase: 'EVALUATION', bullClaims: [bullClaim],
      bearCounterpoints: [bearCounterpoint], rebuttalClaims: [bullClaim],
      discussion: [{ agent: 'bear', type: 'challenge', content: 'The observation may not establish durability.' }],
      availableCategories: { marketMomentum: false, risk: true },
    });

    expect(bear.specialist.bullClaims).toEqual([bullClaim]);
    expect(rebuttal.specialist.bearCounterpoints).toEqual([bearCounterpoint]);
    expect(judge.specialist.rebuttalClaims).toEqual([bullClaim]);
    expect(renderSpecialistContext(judge).roleZone).toContain('AUTHORITATIVE UPSTREAM DEBATE STATE');
    expect(new Set([
      renderSpecialistContext(bear).evidenceZone,
      renderSpecialistContext(rebuttal).evidenceZone,
      renderSpecialistContext(judge).evidenceZone,
    ]).size).toBe(1);
  });

  it('rejects cross-execution evidence and missing required upstream outputs', () => {
    expect(() => assembleSpecialistContext({ ...common, executionId: 'execution-2', role: 'BULL', phase: 'THESIS' })).toThrow(/execution/i);
    expect(() => assembleSpecialistContext({ ...common, role: 'BEAR', phase: 'CHALLENGE' })).toThrow(/Bull/i);
    expect(() => assembleSpecialistContext({ ...common, role: 'BULL', phase: 'REBUTTAL', bullClaims: [bullClaim] })).toThrow(/Bear/i);
    expect(() => assembleSpecialistContext({ ...common, role: 'JUDGE', phase: 'EVALUATION', bullClaims: [bullClaim], bearCounterpoints: [bearCounterpoint], rebuttalClaims: [] })).toThrow();
  });

  it('rejects claims and counterpoints that are not grounded in the selected execution evidence', () => {
    const foreignClaim = { ...bullClaim, evidenceIds: ['33333333-3333-4333-8333-333333333333'] };
    expect(() => assembleSpecialistContext({ ...common, role: 'BEAR', phase: 'CHALLENGE', bullClaims: [foreignClaim] })).toThrow(/evidence/i);
    expect(() => assembleSpecialistContext({
      ...common, role: 'BULL', phase: 'REBUTTAL', bullClaims: [bullClaim],
      bearCounterpoints: [{ ...bearCounterpoint, targetClaimId: 'missing-claim' }],
    })).toThrow(/claim/i);
  });

  it('keeps specialist snapshots explicit without changing conversation snapshot semantics', () => {
    const context = assembleSpecialistContext({ ...common, role: 'BULL', phase: 'THESIS' });
    const snapshot = createContextSnapshot({ sessionId: 'session-1', turnId: 'turn-1', packet: context, createdAt: '2026-09-18T00:00:00.000Z' });

    expect(snapshot.packet.contextKind).toBe('SPECIALIST');
    expect(snapshot.packet.specialist.role).toBe('BULL');
    expect(snapshot.workingContextVersion).toBe(0);
    expect(snapshot.packetFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
