import { describe, expect, it } from 'vitest';
import type { BearCounterpoint, Claim, Evidence } from '@harness/schemas';
import {
  SpecialistContextPacketSchema,
  assembleSpecialistContext,
  budgetSpecialistContext,
  estimateTextTokens,
  renderSpecialistContext,
} from '../src/index.js';

const EVIDENCE_ID = '11111111-1111-4111-8111-111111111111';
const evidence: Evidence[] = [{
  id: EVIDENCE_ID, runId: 'execution-1', ticker: 'BBCA', source: 'sectors.company_report', sourceType: 'api',
  contentHash: 'hash-a', retrievedAt: '2026-09-18T00:00:00.000Z', data: { financials: { roe: 18.4 } },
}];
const claim: Claim = {
  claimId: 'claim-1', statement: 'Profitability supports the constructive thesis.', confidence: 'strong',
  reasoning: 'The cited company report provides the supporting profitability observation.', evidenceIds: [EVIDENCE_ID],
};
const counterpoint: BearCounterpoint = {
  targetClaimId: 'claim-1', argument: 'The observation may not establish durability.', strength: 'moderate',
};

function judgeContext() {
  return assembleSpecialistContext({
    sessionId: 'session-1', turnId: 'turn-1', executionId: 'execution-1', ticker: 'BBCA', roundNumber: 1,
    evidence, role: 'JUDGE', phase: 'EVALUATION', bullClaims: [claim], bearCounterpoints: [counterpoint],
    rebuttalClaims: [claim], discussion: [{ agent: 'bear', type: 'challenge', content: 'A long debate transcript that is lower priority than the typed state.' }],
    availableCategories: { marketMomentum: false, risk: true },
  });
}

describe('specialist context budgeting', () => {
  it('drops discussion before authoritative Evidence and typed debate state', () => {
    const source = judgeContext();
    const minimal = SpecialistContextPacketSchema.parse({
      ...source,
      specialist: { ...source.specialist, discussion: [] },
    });
    const basePrompt = 'persona and mandatory skills';
    const currentUserMessage = 'evaluate the debate';
    const available = estimateTextTokens(renderSpecialistContext(minimal).rendered);
    const result = budgetSpecialistContext({
      context: source,
      modelCapabilities: { contextWindowTokens: available + estimateTextTokens(basePrompt) + estimateTextTokens(currentUserMessage) },
      basePrompt, currentUserMessage, reservedOutputTokens: 0, safetyMarginTokens: 0,
    });

    expect(result.compacted).toBe(true);
    expect(result.actions.map(action => action.code)).toContain('DROP_DISCUSSION');
    expect(result.finalPacket.specialist.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(result.finalPacket.specialist.bullClaims).toEqual([claim]);
    expect(result.finalPacket.specialist.discussion).toEqual([]);
  });

  it('fails closed when the minimum Evidence zone cannot fit', () => {
    expect(() => budgetSpecialistContext({
      context: judgeContext(), modelCapabilities: { contextWindowTokens: 1 }, basePrompt: '', currentUserMessage: '',
      reservedOutputTokens: 0, safetyMarginTokens: 0,
    })).toThrow('exceeds the available budget');
  });
});
