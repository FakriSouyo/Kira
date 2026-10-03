import { EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';

export function acceptedFinancialEvidence(params: {
  id: string;
  runId: string;
  kind: 'company_report' | 'quarterly_financials' | 'daily_transaction' | 'foreign_flow' | 'news' | 'filings' | 'sentiment';
  data: Record<string, unknown>;
}): Evidence {
  const metadata = {
    providerId: 'test-provider',
    source: `sectors.${params.kind}`,
    origin: 'MOCK' as const,
    fetchedAt: '2025-12-01T00:00:00.000Z',
    dataAsOf: params.kind === 'company_report' ? '2025-12-31' : null,
    requestedAsOf: null,
    period: null,
    derivedFrom: [],
  };
  const provenance = {
    metadata,
    verification: { schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: 'PASS' },
    observationKind: params.kind,
  };
  return {
    id: params.id,
    runId: params.runId,
    ticker: 'BBCA',
    source: metadata.source,
    sourceType: 'mock',
    contentHash: 'a'.repeat(64),
    retrievedAt: '2025-12-01T00:00:00.000Z',
    data: params.data,
    provenance,
    acceptance: {
      policyId: EVIDENCE_POLICY_ID,
      policyFingerprint: EVIDENCE_POLICY_FINGERPRINT,
      candidateKind: 'financial',
      sourceOrigin: metadata.origin,
      retrievedAt: metadata.fetchedAt,
      acceptedAt: '2025-12-02T00:00:00.000Z',
      validAt: null,
      provenance,
    },
  };
}
