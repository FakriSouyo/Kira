import { describe, expect, it } from 'vitest';
import { BEAR_SYSTEM_PROMPT, BearAgent, BullAgent, EVIDENCE_PREAMBLE } from '../src/index';
import { CLAIM_1, CLAIM_2, EVIDENCE_1, EVIDENCE_2, fakeEvidenceStore, fakeLLM } from './fakes';

const BEAR_OUTPUT = {
  reasoning:
    'The bullish thesis rests on a single reporting window. I challenge the durability of the cited figures.',
  counterpoints: [
    {
      targetClaimId: CLAIM_1.claimId,
      argument: 'ROE of 23.1% can partly reflect leverage; the report does not break out the balance sheet.',
      strength: 'moderate' as const,
    },
    {
      targetClaimId: CLAIM_2.claimId,
      argument: 'Growth is asserted from the latest quarter alone; consistency is not established.',
      strength: 'high' as const,
    },
  ],
  evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id],
};

describe('BearAgent (Phase 1 — Debate ronde, addendum §15)', () => {
  it('reads evidence read-only and returns a pure challenge response with messageId', async () => {
    const { store, reads } = fakeEvidenceStore();
    const { llm } = fakeLLM(BEAR_OUTPUT);
    const agent = new BearAgent(llm, store);

    const response = await agent.challenge({
      ticker: 'BBCA',
      evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id],
      bullClaims: [CLAIM_1, CLAIM_2],
    });

    expect(reads).toEqual([[EVIDENCE_1.id, EVIDENCE_2.id]]);
    expect(response.messageId).toMatch(/^bear_/);
    expect(response.reasoning).toBe(BEAR_OUTPUT.reasoning);
    expect(response.counterpoints).toHaveLength(2);
    expect(response.evidenceIds).toEqual([EVIDENCE_1.id, EVIDENCE_2.id]);
  });

  it('sends zone [1] = preamble + evidence block, zone [2] = Bear persona (addendum §17)', async () => {
    const { store } = fakeEvidenceStore();
    const { llm, calls } = fakeLLM(BEAR_OUTPUT);
    const agent = new BearAgent(llm, store);

    await agent.challenge({
      ticker: 'BBCA',
      evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id],
      bullClaims: [CLAIM_1, CLAIM_2],
    });

    const call = calls[0];
    const system = call.system as string[];
    expect(system).toHaveLength(2);
    expect(system[1]).toBe(BEAR_SYSTEM_PROMPT);
    expect(system[0]).toContain(EVIDENCE_PREAMBLE);
    expect(system[0]).toContain(EVIDENCE_1.id);
    expect(system[0]).toContain(EVIDENCE_2.id);
  });

  it('prompt exposes each bull claim id so targetClaimId can be valid (run-scoped validation)', async () => {
    const { store } = fakeEvidenceStore();
    const { llm, calls } = fakeLLM(BEAR_OUTPUT);
    const agent = new BearAgent(llm, store);

    await agent.challenge({
      ticker: 'BBCA',
      evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id],
      bullClaims: [CLAIM_1, CLAIM_2],
    });

    const prompt = calls[0].prompt;
    expect(prompt).toContain('Bull Agent made the following claims');
    expect(prompt).toContain(`(claim: ${CLAIM_1.claimId}, Confidence: ${CLAIM_1.confidence})`);
    expect(prompt).toContain(`(claim: ${CLAIM_2.claimId}, Confidence: ${CLAIM_2.confidence})`);
    expect(prompt).toContain(CLAIM_1.statement);
  });

  it('zone [1] is byte-identical to the Bull zone for the same evidence (cache-friendly)', async () => {
    const { store } = fakeEvidenceStore();
    const { llm: bullLlm, calls: bullCalls } = fakeLLM({});
    const { llm: bearLlm, calls: bearCalls } = fakeLLM(BEAR_OUTPUT);
    const bull = new BullAgent(bullLlm, store);
    const bear = new BearAgent(bearLlm, store);

    await bull.analyze({ ticker: 'BBCA', evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id] });
    await bear.challenge({
      ticker: 'BBCA',
      evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id],
      bullClaims: [CLAIM_1, CLAIM_2],
    });

    expect((bearCalls[0].system as string[])[0]).toBe((bullCalls[0].system as string[])[0]);
  });
});
