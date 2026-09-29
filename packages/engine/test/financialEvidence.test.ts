import { describe, expect, it, vi } from 'vitest';
import { verifyAndPersistFinancialEvidence } from '@harness/engine';
import type { EvidenceStore } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import { FinancialDataVerificationError, type FinancialDataResult, type CompanyReport } from '@harness/financial-data';

const executionId = 'execution-financial-evidence';
const ticker = 'BBRI';
const report: CompanyReport = {
  ticker,
  financials: { roe: 22.4 },
  valuation: { pe: 12.1 },
};
const result: FinancialDataResult<CompanyReport> = {
  data: report,
  metadata: {
    providerId: 'test-provider',
    source: 'mock.company_report',
    origin: 'MOCK',
    fetchedAt: '2026-09-25T00:00:00.000Z',
    dataAsOf: null,
    requestedAsOf: null,
    period: null,
    derivedFrom: [],
  },
};

const persistedEvidence = {
  id: 'evidence-financial-1',
  runId: executionId,
  ticker,
  source: result.metadata.source,
  sourceType: 'mock',
  contentHash: 'a'.repeat(64),
  retrievedAt: result.metadata.fetchedAt,
  validAt: null,
  data: report,
  provenance: { metadata: result.metadata, verification: { schema: 'PASS' } },
  acceptance: undefined,
  createdAt: '2026-09-25T00:00:01.000Z',
} as unknown as Evidence;

function createEvidenceStore() {
  const accept = vi.fn(async (_params: Parameters<EvidenceStore['accept']>[0]) => persistedEvidence);
  return { accept };
}

describe('verified financial Evidence acquisition', () => {
  it('persists a policy-accepted result and links the returned Evidence identity', async () => {
    const evidenceStore = createEvidenceStore();

    const acquired = await verifyAndPersistFinancialEvidence({
      executionId,
      ticker,
      kind: 'company_report',
      result,
      evidenceStore,
    });

    expect(acquired).toMatchObject({
      accepted: true,
      evidence: persistedEvidence,
      observation: {
        kind: 'company_report',
        status: 'PRESENT',
        data: report,
        verification: { schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: 'PASS' },
        evidenceIds: [persistedEvidence.id],
      },
    });
    expect(evidenceStore.accept).toHaveBeenCalledTimes(1);
    expect(evidenceStore.accept.mock.calls[0]?.[0]).toMatchObject({
      runId: executionId,
      ticker,
      source: result.metadata.source,
      data: report,
      acceptance: {
        accepted: true,
        executionId,
        ticker,
        policyId: 'evidence-policy-v1',
        candidateKind: 'financial',
        sourceOrigin: 'MOCK',
      },
    });
  });

  it('propagates financial verification failures before persistence', async () => {
    const evidenceStore = createEvidenceStore();
    const wrongSubject: FinancialDataResult<CompanyReport> = {
      ...result,
      data: { ...report, ticker: 'BBCA' },
    };

    await expect(verifyAndPersistFinancialEvidence({
      executionId,
      ticker,
      kind: 'company_report',
      result: wrongSubject,
      evidenceStore,
    })).rejects.toBeInstanceOf(FinancialDataVerificationError);
    expect(evidenceStore.accept).not.toHaveBeenCalled();
  });

  it('returns canonical Evidence policy rejection without persisting', async () => {
    const evidenceStore = createEvidenceStore();

    await expect(verifyAndPersistFinancialEvidence({
      executionId: '',
      ticker,
      kind: 'company_report',
      result,
      evidenceStore,
    })).resolves.toEqual({
      accepted: false,
      policyId: 'evidence-policy-v1',
      reason: 'MISSING_EXECUTION_SCOPE',
    });
    expect(evidenceStore.accept).not.toHaveBeenCalled();
  });

  it('propagates Evidence persistence failures without wrapping them', async () => {
    const failure = Object.assign(new Error('Evidence store unavailable'), { code: 'STORE_UNAVAILABLE' });
    const evidenceStore = { accept: vi.fn().mockRejectedValue(failure) } as unknown as Pick<EvidenceStore, 'accept'>;

    await expect(verifyAndPersistFinancialEvidence({
      executionId,
      ticker,
      kind: 'company_report',
      result,
      evidenceStore,
    })).rejects.toBe(failure);
    expect(evidenceStore.accept).toHaveBeenCalledTimes(1);
  });
});
