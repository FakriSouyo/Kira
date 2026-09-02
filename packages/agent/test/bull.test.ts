import { describe, expect, it } from 'vitest';
import { BULL_SYSTEM_PROMPT, BullAgent, EVIDENCE_PREAMBLE } from '../src/index';
import { EVIDENCE_1, EVIDENCE_2, fakeEvidenceStore, fakeLLM } from './fakes';

const BULL_OUTPUT = {
  reasoning: 'BBCA shows strong profitability and consistent growth.',
  claims: [
    {
      claimId: 'claim_1',
      statement: 'Profitability remains strong.',
      confidence: 'strong' as const,
      reasoning: 'ROE of 23.1% indicates strong and efficient profitability for the bank.',
      evidenceIds: [EVIDENCE_1.id],
    },
  ],
  evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id],
};

describe('BullAgent', () => {
  it('reads evidence read-only and returns a pure response with messageId', async () => {
    const { store, reads } = fakeEvidenceStore();
    const { llm } = fakeLLM(BULL_OUTPUT);
    const agent = new BullAgent(llm, store);

    const response = await agent.analyze({ ticker: 'BBCA', evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id] });

    expect(reads).toEqual([[EVIDENCE_1.id, EVIDENCE_2.id]]);
    expect(response.messageId).toMatch(/^bull_/);
    expect(response.reasoning).toBe(BULL_OUTPUT.reasoning);
    expect(response.claims).toHaveLength(1);
  });

  it('sends zone [1] = preamble + evidence block, zone [2] = Bull persona (addendum §17)', async () => {
    const { store } = fakeEvidenceStore();
    const { llm, calls } = fakeLLM(BULL_OUTPUT);
    const agent = new BullAgent(llm, store);

    await agent.analyze({ ticker: 'BBCA', evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id] });

    const call = calls[0];
    const system = call.system as string[];
    expect(system).toHaveLength(2);
    expect(system[1]).toBe(BULL_SYSTEM_PROMPT);
    expect(system[0]).toContain(EVIDENCE_PREAMBLE);
    expect(system[0]).toContain(EVIDENCE_1.id);
    expect(system[0]).toContain(EVIDENCE_2.id);
    expect(system[0]).toContain('23.1'); // data evidence ikut di zona [1]
    expect(call.prompt).toContain('BBCA');
  });

  it('zone [1] is byte-identical across runs with the same evidence (cache-friendly)', async () => {
    const { store } = fakeEvidenceStore();
    const { llm, calls } = fakeLLM(BULL_OUTPUT);
    const agent = new BullAgent(llm, store);

    await agent.analyze({ ticker: 'BBCA', evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id] });
    await agent.analyze({ ticker: 'BBCA', evidenceIds: [EVIDENCE_1.id, EVIDENCE_2.id] });

    expect(calls[0].system).toEqual(calls[1].system);
  });

  it('prompt contains no volatile per-call data (no timestamps)', async () => {
    const { store } = fakeEvidenceStore();
    const { llm, calls } = fakeLLM(BULL_OUTPUT);
    const agent = new BullAgent(llm, store);

    await agent.analyze({ ticker: 'BBCA', evidenceIds: [EVIDENCE_1.id] });

    const system = (calls[0].system as string[]).join('\n');
    expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // tanpa ISO timestamp
  });
});
