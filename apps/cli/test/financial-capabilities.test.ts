import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@harness/database';
import type { FinancialDataProvider, ScreenerResult } from '@harness/financial-data';
import { createEngineCapabilityRuntime, financialToolIds, JUDGE_CAPABILITY_PRINCIPALS, SCREEN_CAPABILITY_PRINCIPAL } from '@harness/engine';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { buildContext } from '../src/context';

const JUDGE_CAPABILITY_PLAN_BASELINE = '520f35cdbe2c9ebcc8d34c8095a911a1a940a47e619d1f5111281d828f1dcc73';
const screened: ScreenerResult[] = [{ ticker: 'BBCA', matchScore: 100 }];

function provider(): FinancialDataProvider {
  return {
    getCompanyReport: vi.fn(),
    getQuarterlyFinancials: vi.fn(),
    screen: vi.fn(async () => screened),
    getDailyTransaction: vi.fn(),
    getForeignFlow: vi.fn(),
    getNews: vi.fn(),
    getFilings: vi.fn(),
    getSentiment: vi.fn(),
  } as unknown as FinancialDataProvider;
}

function capabilityRuntime(financialData: FinancialDataProvider) {
  return createEngineCapabilityRuntime({
    financialData,
    attachmentStore: {} as never,
    documentStore: {} as never,
    sessionId: 'test-session',
  });
}

describe('CLI financial capability composition', () => {
  it('exposes all eight financial registrations to their exact Screen and Judge principals', () => {
    const { capabilityGateway: gateway } = capabilityRuntime(provider());

    expect(gateway.list(SCREEN_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([financialToolIds.screen]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.identifyCompany).map(({ id }) => id)).toEqual([financialToolIds.companyReport]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchFinancials).map(({ id }) => id)).toEqual([financialToolIds.quarterlyFinancials]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchMarketData).map(({ id }) => id)).toEqual([
      financialToolIds.dailyTransaction,
      financialToolIds.foreignFlow,
    ]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchNews).map(({ id }) => id)).toEqual([
      financialToolIds.filings,
      financialToolIds.news,
      financialToolIds.sentiment,
    ]);
    expect(gateway.list(SCREEN_CAPABILITY_PRINCIPAL).every(descriptor => descriptor.integrationId === 'financial-data')).toBe(true);
  });

  it('keeps Screen restricted to financial.screen and invokes the supplied provider', async () => {
    const data = provider();
    const { capabilityGateway: gateway } = capabilityRuntime(data);

    expect(() => gateway.describe(SCREEN_CAPABILITY_PRINCIPAL, financialToolIds.companyReport))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    await expect(gateway.invoke(SCREEN_CAPABILITY_PRINCIPAL, financialToolIds.screen, { criteria: ['profitable'] }))
      .resolves.toMatchObject({ value: screened });
    expect(data.screen).toHaveBeenCalledWith(['profitable']);
  });

  it('keeps Judge plan semantics and fingerprint at the pre-extraction baseline', () => {
    const { judgeCapabilityPlan } = capabilityRuntime(provider());

    expect(judgeCapabilityPlan.principals.map(({ principalId }) => principalId)).toEqual([
      'workflow.judge.fetch-financials',
      'workflow.judge.fetch-market-data',
      'workflow.judge.fetch-news',
      'workflow.judge.identify-company',
    ]);
    expect(judgeCapabilityPlan.fingerprint).toBe(JUDGE_CAPABILITY_PLAN_BASELINE);
  });

  it('buildContext exposes only the engine Gateway and Judge plan as capability runtime state', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kira-financial-capabilities-'));
    const db = openDb({ homeDir });

    try {
      const context = buildContext(
        db,
        loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
        { sessionId: 'test-session' },
      );

      expect(context.capabilityGateway.list(SCREEN_CAPABILITY_PRINCIPAL).map(({ id }) => id))
        .toEqual([financialToolIds.screen]);
      expect(() => context.capabilityGateway.describe(SCREEN_CAPABILITY_PRINCIPAL, financialToolIds.companyReport))
        .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
      expect(context.judgeCapabilityPlan.fingerprint).toBe(JUDGE_CAPABILITY_PLAN_BASELINE);
      expect(context).not.toHaveProperty('capabilityRegistry');
      expect(context).not.toHaveProperty('capabilityPolicy');
    } finally {
      db.raw.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
