import { describe, expect, it } from 'vitest';
import { verifyFinancialObservation } from '@harness/financial-data';
import {
  createDocumentEvidenceCandidate, createFinancialEvidenceCandidate, decideEvidenceCandidate,
  EVIDENCE_POLICY, EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID,
} from '../src/index';

const observation = verifyFinancialObservation('company_report', {
  data: { ticker: 'BBRI', asOf: '2026-09-18', financials: { roe: 23.1 }, valuation: { pe: 10 } },
  metadata: {
    providerId: 'sectors', source: 'sectors.company_report', origin: 'CACHE' as const,
    fetchedAt: '2026-09-19T00:00:00.000Z', dataAsOf: '2026-09-18T00:00:00.000Z',
    requestedAsOf: null, period: null, derivedFrom: [],
  },
}, 'BBRI');

describe('T Evidence Policy', () => {
  it('accepts a verified financial observation and retains exact metadata without inventing validAt', () => {
    const candidate = createFinancialEvidenceCandidate({ executionId: 'run_a', ticker: 'BBRI', observation });
    const decision = decideEvidenceCandidate(candidate, '2026-09-20T00:00:00.000Z');
    expect(decision).toMatchObject({
      accepted: true, policyId: EVIDENCE_POLICY_ID, candidateKind: 'financial', sourceOrigin: 'CACHE',
      retrievedAt: observation.metadata.fetchedAt, validAt: null,
      provenance: { metadata: observation.metadata, verification: observation.verification },
    });
  });

  it('rejects a forged or malformed financial observation through the authoritative verifier', () => {
    const candidate = createFinancialEvidenceCandidate({ executionId: 'run_a', ticker: 'BBRI', observation });
    const forged = { ...candidate, data: { ticker: 'BBCA' } };
    expect(decideEvidenceCandidate(forged, '2026-09-20T00:00:00.000Z')).toMatchObject({ accepted: false });
  });

  it('has a stable versioned fingerprint and represents document citations only as candidates', () => {
    expect(EVIDENCE_POLICY_ID).toBe('evidence-policy-v1');
    expect(EVIDENCE_POLICY_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/);
    expect(EVIDENCE_POLICY).toMatchObject({ version: 1, id: EVIDENCE_POLICY_ID, fingerprint: EVIDENCE_POLICY_FINGERPRINT });
    expect(Object.isFrozen(EVIDENCE_POLICY)).toBe(true);
    const hit = {
      score: 1, text: 'Revenue grew during the quarter.',
      chunk: {
        chunkId: 'chunk-1', schemaVersion: 1 as const, documentId: 'doc-1', ordinal: 0,
        text: 'Revenue grew during the quarter.', contentHash: 'a'.repeat(64),
        pageStart: 1, pageEnd: 1, lineStart: null, lineEnd: null, section: null,
      },
      citation: {
        attachmentId: 'attachment-1', documentId: 'doc-1', chunkId: 'chunk-1', filename: 'report.pdf',
        sourceContentHash: 'b'.repeat(64), contentHash: 'a'.repeat(64),
        pageStart: 1, pageEnd: 1, lineStart: null, lineEnd: null, section: null,
      },
    };
    const candidate = createDocumentEvidenceCandidate({ executionId: 'execution-1', ticker: 'BBRI', hit });
    expect(candidate).toMatchObject({ kind: 'document', executionId: 'execution-1', ticker: 'BBRI', hit });
    expect(decideEvidenceCandidate(candidate, '2026-09-20T00:00:00.000Z')).toMatchObject({ accepted: false });
  });
});
