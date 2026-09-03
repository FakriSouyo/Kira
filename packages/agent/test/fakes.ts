import type { EvidenceStore } from '@harness/evidence';
import type { Claim, Evidence, Intent, Judgment } from '@harness/schemas';
import type { GenerateObjectParams, LLMClientLike } from '@harness/llm';

export const EVIDENCE_1: Evidence = {
  id: '11111111-aaaa-4aaa-8aaa-111111111111',
  runId: 'run_test',
  ticker: 'BBCA',
  source: 'sectors.company_report',
  sourceType: 'api',
  contentHash: 'hash1',
  retrievedAt: '2024-01-01T00:00:00.000Z',
  data: { ticker: 'BBCA', financials: { roe: 23.1 } },
  provenance: null,
};

export const EVIDENCE_2: Evidence = {
  id: '22222222-bbbb-4bbb-8bbb-222222222222',
  runId: 'run_test',
  ticker: 'BBCA',
  source: 'sectors.quarterly_financials',
  sourceType: 'api',
  contentHash: 'hash2',
  retrievedAt: '2024-01-01T00:00:00.000Z',
  data: { ticker: 'BBCA', quarters: [{ period: '2024-Q4', revenueGrowthYoy: 9.8 }] },
  provenance: null,
};

/** EvidenceStore read-only untuk test agent (agent tidak boleh menulis). */
export function fakeEvidenceStore(evidence: Evidence[] = [EVIDENCE_1, EVIDENCE_2]): {
  store: EvidenceStore;
  reads: string[][];
} {
  const reads: string[][] = [];
  const store: EvidenceStore = {
    save: async () => {
      throw new Error('fakeEvidenceStore is read-only — agents must not write');
    },
    getManyByIds: async (ids) => {
      reads.push(ids);
      return evidence.filter((e) => ids.includes(e.id));
    },
    getByTicker: async () => [],
    getByRun: async () => [],
  };
  return { store, reads };
}

/** LLMClientLike yang mengembalikan output tetap dan mencatat param pemanggilan. */
class FakeLLM implements LLMClientLike {
  calls: GenerateObjectParams<unknown>[] = [];

  constructor(private readonly output: unknown) {}

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    this.calls.push(params as GenerateObjectParams<unknown>);
    return this.output as T;
  }

  async generateText(): Promise<string> {
    return '';
  }

  async *streamText(): AsyncIterable<string> {
    // tidak dipakai di test agent — stub minimal agar FakeLLM memenuhi LLMClientLike
  }
}

export function fakeLLM<T>(output: T): { llm: LLMClientLike; calls: GenerateObjectParams<unknown>[] } {
  const llm = new FakeLLM(output);
  return { llm, calls: llm.calls };
}

export const CLAIM_1: Claim = {
  claimId: 'claim_1',
  statement: 'Profitability remains strong.',
  confidence: 'strong',
  reasoning: 'ROE of 23.1% indicates strong and efficient profitability for the bank.',
  evidenceIds: [EVIDENCE_1.id],
};

export const CLAIM_2: Claim = {
  claimId: 'claim_2',
  statement: 'Earnings growth remains positive.',
  confidence: 'moderate',
  reasoning: 'Quarterly financials show net income growing consistently year over year.',
  evidenceIds: [EVIDENCE_2.id],
};

export const SAMPLE_JUDGMENT: Judgment = {
  ticker: 'BBCA',
  score: 72,
  stance: 'bullish',
  confidence: 'moderate',
  breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
  summary: 'Bull presents consistent, evidence-backed signals.',
};

export const SAMPLE_INTENT: Intent = { type: 'judge', confidence: 0.9, ticker: 'BBCA' };
