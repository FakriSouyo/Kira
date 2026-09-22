import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityGateway,
  CapabilityPolicy,
  CapabilityRegistry,
  createCapabilityPlan,
} from '@harness/capability';
import { openDb } from '@harness/database';
import type { FinancialDataProvider, ScreenerResult } from '@harness/financial-data';
import type { FinancialTools } from '../src/tools/financialTools';
import { ToolRuntime } from '@harness/tool-runtime';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import { buildContext } from '../src/context';
import {
  createFinancialCapabilityRegistrations,
  createFinancialCapabilityGrants,
  createJudgeCapabilityPlan,
  FINANCIAL_CAPABILITY_INTEGRATION_ID,
  JUDGE_CAPABILITY_PRINCIPALS,
  SCREEN_CAPABILITY_PRINCIPAL,
} from '../src/tools/financialCapabilities';
import { createFinancialTools, financialToolIds } from '../src/tools/financialTools';
import { attachmentToolIds, createAttachmentTools } from '../src/tools/attachmentTools';
import { createDocumentTools } from '../src/tools/documentTools';
import {
  createApplicationCapabilityGrants,
  createApplicationCapabilityGateway,
  createApplicationCapabilityRegistrations,
} from '../src/tools/applicationCapabilities';
import {
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  createAttachmentCapabilityGrants,
  createAttachmentCapabilityRegistrations,
} from '../src/tools/attachmentCapabilities';

function applicationGateway(tools: FinancialTools) {
  return createApplicationCapabilityGateway({
    financialTools: tools,
    attachmentTools: createAttachmentTools({ attachmentStore: {} as never, sessionId: 'test-session' }),
    documentTools: createDocumentTools({ documentStore: {} as never, sessionId: 'test-session' }),
    toolRuntime: new ToolRuntime(),
  });
}

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
    const gateway = applicationGateway(tools);

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

  it('grants Judge by explicit workflow principal and creates a scoped seven-capability plan', () => {
    const tools = createFinancialTools(provider());
    const gateway = applicationGateway(tools);

    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.identifyCompany).map(({ id }) => id)).toEqual([
      financialToolIds.companyReport,
    ]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchFinancials).map(({ id }) => id)).toEqual([
      financialToolIds.quarterlyFinancials,
    ]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchMarketData).map(({ id }) => id)).toEqual([
      financialToolIds.dailyTransaction,
      financialToolIds.foreignFlow,
    ]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchNews).map(({ id }) => id)).toEqual([
      financialToolIds.filings,
      financialToolIds.news,
      financialToolIds.sentiment,
    ]);
    expect(() => gateway.describe(
      JUDGE_CAPABILITY_PRINCIPALS.identifyCompany,
      financialToolIds.screen,
    )).toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));

    const plan = createJudgeCapabilityPlan(gateway);
    expect(plan.principals.map(({ principalId }) => principalId)).toEqual([
      'workflow.judge.fetch-financials',
      'workflow.judge.fetch-market-data',
      'workflow.judge.fetch-news',
      'workflow.judge.identify-company',
    ]);
    expect(plan.principals.flatMap(({ capabilities }) => capabilities.map(({ id }) => id))).toEqual([
      financialToolIds.quarterlyFinancials,
      financialToolIds.dailyTransaction,
      financialToolIds.foreignFlow,
      financialToolIds.filings,
      financialToolIds.news,
      financialToolIds.sentiment,
      financialToolIds.companyReport,
    ]);
    expect(plan.principals.flatMap(({ capabilities }) => capabilities.map(({ id }) => id))).not.toContain(financialToolIds.screen);
  });

  it('buildContext exposes only the Gateway as the production capability boundary', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'finharness-financial-capabilities-'));
    const db = openDb({ homeDir });

    try {
      const context = buildContext(
        db,
        loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
        { sessionId: 'test-session' },
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

  it('keeps the Judge plan isolated from unrelated grants and registrations', () => {
    const makePlan = (screenGrant: readonly string[], includeAttachmentGrant = false) => {
      const tools = createFinancialTools(provider());
      const attachments = createAttachmentTools({ attachmentStore: {} as never, sessionId: 'test-session' });
      const documents = createDocumentTools({ documentStore: {} as never, sessionId: 'test-session' });
      const registry = new CapabilityRegistry(createApplicationCapabilityRegistrations({
        financialTools: tools,
        attachmentTools: attachments,
        documentTools: documents,
      }));
      const grants = createFinancialCapabilityGrants()
        .filter(grant => grant.principalId !== SCREEN_CAPABILITY_PRINCIPAL.id);
      grants.push({ principalId: SCREEN_CAPABILITY_PRINCIPAL.id, capabilityIds: screenGrant });
      if (includeAttachmentGrant) grants.push(...createAttachmentCapabilityGrants());
      const policy = new CapabilityPolicy(grants);
      const gateway = new CapabilityGateway({ registry, policy, toolRuntime: new ToolRuntime() });
      return createCapabilityPlan(gateway, Object.values(JUDGE_CAPABILITY_PRINCIPALS));
    };

    expect(makePlan([financialToolIds.screen]).fingerprint)
      .toBe(makePlan([financialToolIds.screen, financialToolIds.news]).fingerprint);
    expect(makePlan([financialToolIds.screen]).fingerprint)
      .toBe(makePlan([financialToolIds.screen], true).fingerprint);
  });

  it('keeps Judge capability IDs and fingerprint identical with and without S3 registration and grant', () => {
    const tools = createFinancialTools(provider());
    const attachmentTools = createAttachmentTools({ attachmentStore: {} as never, sessionId: 'test-session' });
    const documentTools = createDocumentTools({ documentStore: {} as never, sessionId: 'test-session' });
    const s2Registrations = [
      ...createFinancialCapabilityRegistrations(tools),
      ...createAttachmentCapabilityRegistrations(attachmentTools),
    ];
    const s2Grants = [
      ...createFinancialCapabilityGrants(),
      {
        principalId: COMMAND_FILES_CAPABILITY_PRINCIPAL.id,
        capabilityIds: [attachmentToolIds.list],
      },
    ];
    const s3Registrations = createApplicationCapabilityRegistrations({
      financialTools: tools,
      attachmentTools,
      documentTools,
    });
    const planFor = (registrations: typeof s2Registrations, grants: readonly { principalId: string; capabilityIds: readonly string[] }[]) => createCapabilityPlan(new CapabilityGateway({
      registry: new CapabilityRegistry(registrations),
      policy: new CapabilityPolicy(grants),
      toolRuntime: new ToolRuntime(),
    }), Object.values(JUDGE_CAPABILITY_PRINCIPALS));
    const before = planFor(s2Registrations, s2Grants);
    const after = planFor(s3Registrations, createApplicationCapabilityGrants());
    expect(before.principals.map(principal => principal.principalId))
      .toEqual(after.principals.map(principal => principal.principalId));
    expect(before.principals.map(principal => principal.capabilities.map(capability => capability.id)))
      .toEqual(after.principals.map(principal => principal.capabilities.map(capability => capability.id)));
    expect(before.fingerprint).toBe(after.fingerprint);
  });
});
