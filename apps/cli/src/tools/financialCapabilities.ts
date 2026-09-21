import {
  CapabilityGateway,
  CapabilityPolicy,
  CapabilityRegistry,
  createCapabilityPlan,
  type CapabilityPlan,
  type CapabilityRegistration,
} from '@harness/capability';
import type { ToolRuntime } from '@harness/tool-runtime';
import { financialToolIds, type FinancialTools } from './financialTools';

export const FINANCIAL_CAPABILITY_INTEGRATION_ID = 'financial-data' as const;

export const SCREEN_CAPABILITY_PRINCIPAL = Object.freeze({
  id: 'command.screen',
} as const);

export const JUDGE_CAPABILITY_PRINCIPALS = Object.freeze({
  identifyCompany: Object.freeze({ id: 'workflow.judge.identify-company' } as const),
  fetchFinancials: Object.freeze({ id: 'workflow.judge.fetch-financials' } as const),
  fetchMarketData: Object.freeze({ id: 'workflow.judge.fetch-market-data' } as const),
  fetchNews: Object.freeze({ id: 'workflow.judge.fetch-news' } as const),
} as const);

function registration<TTool extends FinancialTools[keyof FinancialTools]>(
  tool: TTool,
  displayName: string,
  description: string,
): CapabilityRegistration<TTool> {
  return Object.freeze({
    descriptor: Object.freeze({
      id: tool.id,
      displayName,
      description,
      kind: 'tool' as const,
      integrationId: FINANCIAL_CAPABILITY_INTEGRATION_ID,
    }),
    tool,
  });
}

export function createFinancialCapabilityRegistrations(tools: FinancialTools) {
  return Object.freeze([
    registration(
      tools.companyReport,
      'Company Report',
      'Retrieve a company financial and valuation report.',
    ),
    registration(
      tools.quarterlyFinancials,
      'Quarterly Financials',
      'Retrieve quarterly company financial results.',
    ),
    registration(
      tools.screen,
      'Financial Screen',
      'Screen the financial universe using explicit criteria.',
    ),
    registration(
      tools.dailyTransaction,
      'Daily Transaction',
      'Retrieve daily transaction and liquidity observations.',
    ),
    registration(
      tools.foreignFlow,
      'Foreign Flow',
      'Retrieve foreign-flow observations for a company.',
    ),
    registration(
      tools.news,
      'Company News',
      'Retrieve recent company news observations.',
    ),
    registration(
      tools.filings,
      'Company Filings',
      'Retrieve company filing observations.',
    ),
    registration(
      tools.sentiment,
      'News Sentiment',
      'Retrieve aggregate company news sentiment.',
    ),
  ] as const);
}

export function createFinancialCapabilityGateway(
  tools: FinancialTools,
  toolRuntime: ToolRuntime,
) {
  const registrations = createFinancialCapabilityRegistrations(tools);
  const registry = new CapabilityRegistry(registrations);
  const policy = new CapabilityPolicy([
    {
      principalId: SCREEN_CAPABILITY_PRINCIPAL.id,
      capabilityIds: [financialToolIds.screen],
    },
    {
      principalId: JUDGE_CAPABILITY_PRINCIPALS.identifyCompany.id,
      capabilityIds: [financialToolIds.companyReport],
    },
    {
      principalId: JUDGE_CAPABILITY_PRINCIPALS.fetchFinancials.id,
      capabilityIds: [financialToolIds.quarterlyFinancials],
    },
    {
      principalId: JUDGE_CAPABILITY_PRINCIPALS.fetchMarketData.id,
      capabilityIds: [financialToolIds.dailyTransaction, financialToolIds.foreignFlow],
    },
    {
      principalId: JUDGE_CAPABILITY_PRINCIPALS.fetchNews.id,
      capabilityIds: [financialToolIds.news, financialToolIds.filings, financialToolIds.sentiment],
    },
  ]);

  return new CapabilityGateway({ registry, policy, toolRuntime });
}

export type FinancialCapabilityGateway = ReturnType<
  typeof createFinancialCapabilityGateway
>;

export function createJudgeCapabilityPlan(
  capabilityGateway: FinancialCapabilityGateway,
): CapabilityPlan {
  return createCapabilityPlan(capabilityGateway, Object.values(JUDGE_CAPABILITY_PRINCIPALS));
}
