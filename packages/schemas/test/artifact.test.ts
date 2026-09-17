import { describe, expect, it } from 'vitest';
import {
  ArtifactEnvelopeSchema,
  ArtifactRefSchema,
  BearCaseArtifactPayloadSchema,
  BullCaseArtifactPayloadSchema,
  VerdictArtifactPayloadSchema,
} from '@harness/schemas';

const EVIDENCE_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const JUDGMENT = {
  ticker: 'BBCA',
  score: 72,
  stance: 'bullish' as const,
  confidence: 'moderate' as const,
  breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
  summary: 'Consistent, evidence-backed signals support a bullish stance.',
};

const BULL_ARGUMENT = {
  messageId: 'bull_run_1',
  reasoning: 'Profitability and growth support the bullish case for the company.',
  claims: [{
    claimId: 'claim_1',
    statement: 'Profitability remains strong for the company.',
    confidence: 'strong' as const,
    reasoning: 'The observed return on equity supports this conclusion.',
    evidenceIds: [EVIDENCE_ID],
  }],
  evidenceIds: [EVIDENCE_ID],
};

const BULL_CASE = { thesis: BULL_ARGUMENT, rebuttal: { ...BULL_ARGUMENT, messageId: 'bull_rebuttal_run_1' } };

const BEAR_OUTPUT = {
  messageId: 'bear_run_1',
  reasoning: 'The valuation leaves room for a meaningful downside challenge.',
  counterpoints: [{ targetClaimId: 'claim_1', argument: 'The claim may overlook valuation risk.', strength: 'moderate' as const }],
  evidenceIds: [EVIDENCE_ID],
};

describe('typed PR F artifact contracts', () => {
  it('accepts only durable typed references', () => {
    expect(ArtifactRefSchema.parse({ kind: 'VERDICT', artifactId: 'artifact_verdict_run_1' })).toEqual({
      kind: 'VERDICT', artifactId: 'artifact_verdict_run_1',
    });
    expect(() => ArtifactRefSchema.parse({ kind: 'VERDICT', artifactId: '' })).toThrow();
    expect(() => ArtifactRefSchema.parse({ kind: 'VERDICT', artifactId: 'array-position-0' })).not.toThrow();
    expect(() => ArtifactRefSchema.parse({ kind: 'judgment', executionId: 'run_1' })).toThrow();
  });

  it('validates payloads according to their artifact kind', () => {
    expect(BullCaseArtifactPayloadSchema.parse(BULL_CASE)).toEqual(BULL_CASE);
    expect(BearCaseArtifactPayloadSchema.parse(BEAR_OUTPUT)).toEqual(BEAR_OUTPUT);
    expect(VerdictArtifactPayloadSchema.parse({ judgment: JUDGMENT, evidenceIds: [EVIDENCE_ID], claimIds: ['claim_1'], rounds: 1 })).toBeTruthy();
    expect(() => BearCaseArtifactPayloadSchema.parse(BULL_CASE)).toThrow();
  });

  it('validates the complete versioned envelope and rejects malformed payloads', () => {
    const envelope = {
      artifactId: 'artifact_bull_case_run_1',
      kind: 'BULL_CASE' as const,
      schemaVersion: 1 as const,
      sessionId: 'session_1',
      turnId: 'turn_1',
      executionId: 'run_1',
      ticker: 'BBCA',
      payload: BULL_CASE,
      createdAt: '2026-09-18T00:00:00.000Z',
    };
    expect(ArtifactEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => ArtifactEnvelopeSchema.parse({ ...envelope, schemaVersion: 2 })).toThrow();
    expect(() => ArtifactEnvelopeSchema.parse({ ...envelope, payload: { ...BULL_CASE, thesis: { ...BULL_ARGUMENT, claims: [] } } })).toThrow();
  });
});
