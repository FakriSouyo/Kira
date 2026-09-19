import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_SNAPSHOT_SCHEMA_VERSION,
  FinancialDataVerificationError,
  createNotRequestedObservation,
  createUnavailableObservation,
  createVerifiedFinancialSnapshot,
  verifyFinancialObservation,
  type CompanyReport,
  type FinancialDataResult,
  type FinancialObservation,
  type FinancialObservationKind,
  type QuarterlyFinancials,
} from '../src/index';

const metadata = {
  providerId: 'sectors',
  source: 'sectors.company_report',
  origin: 'CACHE' as const,
  fetchedAt: '2026-09-19T00:00:00.000Z',
  dataAsOf: '2026-09-18T00:00:00.000Z',
  requestedAsOf: null,
  period: null,
  derivedFrom: [],
};

const report: CompanyReport = {
  ticker: 'BBRI',
  asOf: '2026-09-18T00:00:00.000Z',
  financials: { roe: -4.2 },
  valuation: { pe: -3.1 },
};

const quarterly: QuarterlyFinancials = {
  ticker: 'BBRI',
  quarters: [{ period: '2026-Q2', revenue: -10, netIncome: -2, periodType: 'single_quarter' }],
};

function result<K extends FinancialObservationKind, T>(data: T, source: string): FinancialDataResult<T> {
  return { data, metadata: { ...metadata, source } };
}

function requiredObservations(): FinancialObservation[] {
  return [
    verifyFinancialObservation('company_report', result(report, 'sectors.company_report'), 'BBRI'),
    verifyFinancialObservation('quarterly_financials', {
      data: quarterly,
      metadata: { ...metadata, source: 'sectors.quarterly_financials', dataAsOf: null, period: '2026-Q2' },
    }, 'BBRI'),
  ];
}

function allObservations(): FinancialObservation[] {
  return [
    ...requiredObservations(),
    createNotRequestedObservation('daily_transaction'),
    createNotRequestedObservation('foreign_flow'),
    createNotRequestedObservation('news'),
    createNotRequestedObservation('filings'),
    createNotRequestedObservation('sentiment'),
  ];
}

describe('verified financial snapshot domain', () => {
  it('accepts typed provider data without applying simplistic finance ranges', () => {
    const observation = verifyFinancialObservation('company_report', result(report, 'sectors.company_report'), 'BBRI');

    expect(observation).toMatchObject({
      kind: 'company_report',
      status: 'PRESENT',
      data: report,
      metadata: { providerId: 'sectors', fetchedAt: '2026-09-19T00:00:00.000Z' },
      verification: { schema: 'PASS', subject: 'PASS', provenance: 'PASS' },
      evidenceIds: [],
    });
  });

  it('rejects a returned ticker that does not match the requested subject', () => {
    expect(() => verifyFinancialObservation('company_report', result({ ...report, ticker: 'BBCA' }, 'sectors.company_report'), 'BBRI'))
      .toThrow(FinancialDataVerificationError);
  });

  it('rejects missing provider provenance and explicit post-cutoff data', () => {
    expect(() => verifyFinancialObservation('company_report', {
      data: report,
      metadata: { ...metadata, providerId: '', requestedAsOf: '2026-09-17T00:00:00.000Z' },
    }, 'BBRI')).toThrow(/provenance/i);

    expect(() => verifyFinancialObservation('company_report', {
      data: report,
      metadata: { ...metadata, requestedAsOf: '2026-09-17T00:00:00.000Z', dataAsOf: '2026-09-18T00:00:00.000Z' },
    }, 'BBRI')).toThrow(/temporal|cutoff/i);

    expect(verifyFinancialObservation('quarterly_financials', {
      data: quarterly,
      metadata: { ...metadata, source: 'sectors.quarterly_financials', dataAsOf: null, requestedAsOf: '2026-09-19T00:00:00.000Z', period: '2026-Q2' },
    }, 'BBRI').verification.temporal).toBe('UNKNOWN');

    expect(() => verifyFinancialObservation('sentiment', {
      data: { ticker: 'BBRI', asOf: '2026-09-18T00:00:00.000Z', window: '30d' },
      metadata: { ...metadata, source: 'sectors.sentiment', origin: 'DERIVED', derivedFrom: [] },
    }, 'BBRI')).toThrow(/lineage/i);
  });

  it('represents optional absence as not-requested or unavailable instead of null data', () => {
    expect(createNotRequestedObservation('daily_transaction')).toEqual({
      kind: 'daily_transaction', status: 'NOT_REQUESTED', reason: 'PROFILE_DISABLED',
    });
    expect(createUnavailableObservation('news', 'PROVIDER_ERROR', 'NETWORK')).toEqual({
      kind: 'news', status: 'UNAVAILABLE', reason: 'PROVIDER_ERROR', errorCode: 'NETWORK',
    });
  });

  it('creates deterministic execution-scoped identity while excluding persistence times', () => {
    const observations = allObservations();
    const first = createVerifiedFinancialSnapshot({
      sessionId: 'session-n', turnId: 'turn-n', executionId: 'run-n', ticker: 'BBRI',
      executionStartedAt: '2026-09-19T00:00:00.000Z', finalizedAt: '2026-09-19T00:01:00.000Z',
      observations, materializedEvidenceIds: [],
    });
    const retry = createVerifiedFinancialSnapshot({
      sessionId: 'session-n', turnId: 'turn-n', executionId: 'run-n', ticker: 'BBRI',
      executionStartedAt: '2026-09-19T00:00:00.000Z', finalizedAt: '2026-09-19T01:01:00.000Z',
      observations, materializedEvidenceIds: [],
    });
    const secondExecution = createVerifiedFinancialSnapshot({
      sessionId: 'session-n', turnId: 'turn-n', executionId: 'run-n-2', ticker: 'BBRI',
      executionStartedAt: '2026-09-19T00:00:00.000Z', finalizedAt: '2026-09-19T00:01:00.000Z',
      observations, materializedEvidenceIds: [],
    });

    expect(first.schemaVersion).toBe(FINANCIAL_SNAPSHOT_SCHEMA_VERSION);
    expect(retry.snapshotId).toBe(first.snapshotId);
    expect(retry.fingerprint).toBe(first.fingerprint);
    expect(secondExecution.snapshotId).not.toBe(first.snapshotId);
    expect(secondExecution.fingerprint).not.toBe(first.fingerprint);
    expect(first.completeness).toBe('PARTIAL');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.observations)).toBe(true);
    expect(Object.isFrozen(first.observations[0])).toBe(true);
  });

  it('does not create a verified snapshot without either required observation', () => {
    for (const missing of [0, 1]) {
      expect(() => createVerifiedFinancialSnapshot({
      sessionId: 'session-n', turnId: 'turn-n', executionId: 'run-missing', ticker: 'BBRI',
      executionStartedAt: '2026-09-19T00:00:00.000Z', finalizedAt: '2026-09-19T00:01:00.000Z',
      observations: [requiredObservations()[missing === 0 ? 1 : 0]!], materializedEvidenceIds: [],
      })).toThrow(/required|company|quarterly|exactly one/i);
    }
  });
});
