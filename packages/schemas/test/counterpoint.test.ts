import { describe, expect, it } from 'vitest';
import { BearLLMOutputSchema, BearProposalOutputSchema } from '../src/debate.js';
import { BearCaseArtifactPayloadSchema } from '../src/artifact.js';

const evidenceId = '11111111-1111-4111-8111-111111111111';

const proposal = {
  reasoning: 'The reporting window is too short to establish durable performance.',
  evidenceIds: [evidenceId],
  counterpoints: [{
    targetClaimId: 'claim_1',
    argument: 'The valuation is 12.4x, which leaves little room for execution risk.',
    strength: 'moderate',
    evidenceIds: [evidenceId],
    evidenceLinks: [{ evidenceId, relation: 'qualifies', rationale: 'The report records the valuation multiple.' }],
    citedFigures: [{ evidenceId, path: 'valuation.multiple', value: 12.4, periodLabel: 'FY 2025' }],
  }],
};

describe('Bear Counterpoint proposal compatibility', () => {
  it('reads a pre-T3 historical Bear output without adding grounding metadata', () => {
    const historical = BearLLMOutputSchema.parse({
      reasoning: 'The old checkpoint contains no per-Counterpoint Evidence links.',
      evidenceIds: [evidenceId],
      counterpoints: [{ targetClaimId: 'claim_1', argument: 'The reporting window is short.', strength: 'low' }],
    });

    expect(historical.counterpoints[0]).toEqual({
      targetClaimId: 'claim_1', argument: 'The reporting window is short.', strength: 'low',
    });
  });

  it('accepts current per-Counterpoint Evidence links and cited figures', () => {
    expect(BearProposalOutputSchema.parse(proposal).counterpoints[0]).toMatchObject({
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies' }],
      citedFigures: [{ evidenceId, path: 'valuation.multiple', value: 12.4 }],
    });
  });

  it.each([
    ['counterpointId', { counterpointId: 'llm-owned' }],
    ['policyId', { policyId: 'counterpoint-policy-v1' }],
    ['policyFingerprint', { policyFingerprint: 'llm-owned' }],
  ])('rejects model-owned %s', (_name, extra) => {
    const response = {
      ...proposal,
      counterpoints: [{ ...proposal.counterpoints[0], ...extra }],
    };

    expect(BearProposalOutputSchema.safeParse(response).success).toBe(false);
  });
});

describe('BEAR_CASE Counterpoint compatibility', () => {
  it('reads the strict historical inline shape and retains complete current grounding', () => {
    const legacy = {
      messageId: 'bear_legacy',
      reasoning: 'The old artifact stores only the challenge text and response Evidence.',
      evidenceIds: [evidenceId],
      counterpoints: [{ targetClaimId: 'claim_1', argument: 'The reporting window is short.', strength: 'low' }],
    };
    expect(BearCaseArtifactPayloadSchema.parse(legacy)).toEqual(legacy);

    const current = {
      ...legacy,
      counterpoints: [{
        ...proposal.counterpoints[0],
        counterpointId: 'counterpoint:round-1-bear-challenge:1',
        sourceNodeId: 'round-1-bear-challenge',
        policyId: 'counterpoint-policy-v1',
        policyFingerprint: 'a'.repeat(64),
      }],
    };
    expect(BearCaseArtifactPayloadSchema.parse(current).counterpoints[0]).toMatchObject({
      counterpointId: 'counterpoint:round-1-bear-challenge:1',
      evidenceIds: [evidenceId],
      evidenceLinks: [{ evidenceId, relation: 'qualifies' }],
      citedFigures: [{ evidenceId, path: 'valuation.multiple', value: 12.4 }],
      policyId: 'counterpoint-policy-v1',
    });
  });
});
