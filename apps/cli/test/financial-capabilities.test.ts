import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityRegistry } from '@harness/capability';
import { openDb } from '@harness/database';
import type { FinancialDataProvider, ScreenerResult } from '@harness/financial-data';
import { ToolRuntime } from '@harness/tool-runtime';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { buildContext } from '../src/context';
import {
  createFinancialCapabilityGateway,
  createFinancialCapabilityRegistrations,
  FINANCIAL_CAPABILITY_INTEGRATION_ID,
  SCREEN_CAPABILITY_PRINCIPAL,
} from '../src/tools/financialCapabilities';
import { createFinancialTools, financialToolIds } from '../src/tools/financialTools';

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

describe('financial capability composition', () => {
  it('registers all eight existing financial tools with provider-neutral data-only descriptors', () => {
    const tools = createFinancialTools(provider());
    const registrations = createFinancialCapabilityRegistrations(tools);
    const registry = new CapabilityRegistry(registrations);

    expect(registrations.map(({ descriptor }) => descriptor.id)).toEqual([
      'financial.company-report',
      'financial.quarterly-financials',
      'financial.screen',
      'financial.daily-transaction',
      'financial.foreign-flow',
      'financial.news',
      'financial.filings',
      'financial.sentiment',
    ]);
    expect(registry.list().map(({ id }) => id)).toEqual([
      'financial.company-report',
      'financial.daily-transaction',
      'financial.filings',
      'financial.foreign-flow',
      'financial.news',
      'financial.quarterly-financials',
      'financial.screen',
      'financial.sentiment',
    ]);

    expect(registry.resolveTool(financialToolIds.companyReport)).toBe(tools.companyReport);
    expect(registry.resolveTool(financialToolIds.quarterlyFinancials)).toBe(tools.quarterlyFinancials);
    expect(registry.resolveTool(financialToolIds.screen)).toBe(tools.screen);
    expect(registry.resolveTool(financialToolIds.dailyTransaction)).toBe(tools.dailyTransaction);
    expect(registry.resolveTool(financialToolIds.foreignFlow)).toBe(tools.foreignFlow);
    expect(registry.resolveTool(financialToolIds.news)).toBe(tools.news);
    expect(registry.resolveTool(financialToolIds.filings)).toBe(tools.filings);
    expect(registry.resolveTool(financialToolIds.sentiment)).toBe(tools.sentiment);

    expect(Object.isFrozen(registrations)).toBe(true);
    for (const descriptor of registry.list()) {
      expect(descriptor.kind).toBe('tool');
      expect(descriptor.integrationId).toBe(FINANCIAL_CAPABILITY_INTEGRATION_ID);
      expect(Object.keys(descriptor).sort()).toEqual([
        'description',
        'displayName',
        'id',
        'integrationId',
        'kind',
      ]);
      expect(descriptor).not.toHaveProperty('tool');
      expect(descriptor).not.toHaveProperty('execute');
      expect(JSON.stringify(descriptor)).not.toMatch(/sectors/i);
    }
  });

  it('grants the Screen principal only financial.screen', async () => {
    const data = provider();
    const tools = createFinancialTools(data);
    const gateway = createFinancialCapabilityGateway(tools, new ToolRuntime());

    expect(gateway.list(SCREEN_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([
      'financial.screen',
    ]);
    expect(() => gateway.describe(SCREEN_CAPABILITY_PRINCIPAL, financialToolIds.news))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    await expect(gateway.invoke(
      SCREEN_CAPABILITY_PRINCIPAL,
      financialToolIds.news,
      { ticker: 'BBCA' },
    )).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

    await expect(gateway.invoke(
      SCREEN_CAPABILITY_PRINCIPAL,
      financialToolIds.screen,
      { criteria: ['profitable'] },
    )).resolves.toMatchObject({ value: screened });
    expect(data.screen).toHaveBeenCalledWith(['profitable']);
  });

  it('buildContext exposes only the Gateway as the production capability boundary', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'finharness-financial-capabilities-'));
    const db = openDb({ homeDir });

    try {
      const context = buildContext(
        db,
        loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      );

      expect(context.capabilityGateway.list(SCREEN_CAPABILITY_PRINCIPAL).map(({ id }) => id))
        .toEqual(['financial.screen']);
      expect(() => context.capabilityGateway.describe(
        SCREEN_CAPABILITY_PRINCIPAL,
        financialToolIds.companyReport,
      )).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
      expect(context).not.toHaveProperty('capabilityRegistry');
      expect(context).not.toHaveProperty('capabilityPolicy');
    } finally {
      db.raw.close();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
