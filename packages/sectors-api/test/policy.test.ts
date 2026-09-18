import { describe, expect, it } from 'vitest';
import {
  cacheKeyFor,
  evaluateCacheEntry,
  type SectorsCacheRequirement,
} from '../src/index';

const companyReport = (ticker: string, context?: SectorsCacheRequirement['context']): SectorsCacheRequirement => ({
  provider: 'sectors-api',
  operation: 'company_report',
  subjectScope: 'symbol',
  subject: ticker,
  params: { sections: ['overview', 'valuation', 'financials', 'dividend'] },
  temporal: { kind: 'mixed_snapshot' },
  schemaVersion: 1,
  adapterVersion: 'v2',
  context,
});

describe('Sectors cache identity policy', () => {
  it('does not scope a cache identity to workflow, command, Turn, Execution, or run', () => {
    expect(cacheKeyFor(companyReport('BBCA', {
      workflow: 'research', command: 'research', turnId: 't1', executionId: 'e1', runId: 'r1',
    }))).toBe(cacheKeyFor(companyReport('BBCA', {
      workflow: 'judge', command: 'judge', turnId: 't2', executionId: 'e2', runId: 'r2',
    })));
  });

  it('isolates subject-specific operations by symbol', () => {
    expect(cacheKeyFor(companyReport('BBCA'))).not.toBe(cacheKeyFor(companyReport('BBRI')));
  });

  it('allows a genuinely subject-independent requirement to share one identity', () => {
    const shared = (subject: string): SectorsCacheRequirement => ({
      provider: 'sectors-api',
      operation: 'fixture_shared_context',
      subjectScope: 'shared',
      subject,
      params: { window: 'current' },
      temporal: { kind: 'recent_snapshot' },
      schemaVersion: 1,
      adapterVersion: 'fixture',
    });
    expect(cacheKeyFor(shared('BBCA'))).toBe(cacheKeyFor(shared('BBRI')));
  });

  it('returns inspectable reuse/fetch decisions with stable reasons', () => {
    const requirement = companyReport('BBCA');
    const key = cacheKeyFor(requirement);
    const now = new Date('2026-09-17T00:00:00Z');
    const fresh = {
      fetchedAt: now.toISOString(),
      data: { ok: true },
      meta: { cacheIdentity: key, schemaVersion: 1, adapterVersion: 'v2' as const },
    };
    expect(evaluateCacheEntry(requirement, fresh, { now })).toMatchObject({ action: 'reuse', reason: 'fresh' });
    expect(evaluateCacheEntry(requirement, null, { now })).toMatchObject({ action: 'fetch', reason: 'missing' });
  });
});
