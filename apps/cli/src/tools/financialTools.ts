import { z } from 'zod';
import {
  FINANCIAL_OBSERVATION_KINDS,
  type CompanyReport,
  type DailyTransaction,
  type Filing,
  type FinancialDataProvider,
  type FinancialDataResult,
  type ForeignFlow,
  type NewsArticle,
  type QuarterlyFinancials,
  type Sentiment,
} from '@harness/financial-data';
import { defineTool } from '@harness/tool-runtime';

const numberSchema = z.number().finite();
const nullableDateSchema = z.string().nullable();

const financialMetadataSchema = z.object({
  providerId: z.string().min(1),
  source: z.string().min(1),
  origin: z.enum(['PROVIDER', 'CACHE', 'MOCK', 'DERIVED']),
  fetchedAt: nullableDateSchema,
  dataAsOf: nullableDateSchema,
  requestedAsOf: nullableDateSchema,
  period: z.string().nullable(),
  derivedFrom: z.enum(FINANCIAL_OBSERVATION_KINDS).array(),
}).passthrough();

const companyReportSchema = z.object({
  ticker: z.string().min(1),
  name: z.string().optional(),
  sector: z.string().optional(),
  asOf: z.string().optional(),
  financials: z.object({
    roe: numberSchema.optional(),
    roa: numberSchema.optional(),
    netMargin: numberSchema.optional(),
    grossMargin: numberSchema.optional(),
    debtToEquity: numberSchema.optional(),
    currentRatio: numberSchema.optional(),
    yoyQuarterRevenueGrowth: numberSchema.optional(),
    yoyQuarterEarningsGrowth: numberSchema.optional(),
  }).passthrough(),
  valuation: z.object({
    price: numberSchema.optional(),
    pe: numberSchema.optional(),
    pb: numberSchema.optional(),
    dividendYield: numberSchema.optional(),
  }).passthrough(),
}).passthrough();

const quarterlyFinancialsSchema = z.object({
  ticker: z.string().min(1),
  currency: z.string().optional(),
  quarters: z.array(z.object({
    period: z.string().min(1),
    periodType: z.literal('single_quarter').optional(),
    revenue: numberSchema,
    netIncome: numberSchema,
    revenueGrowthYoy: numberSchema.optional(),
    netIncomeGrowthYoy: numberSchema.optional(),
  }).passthrough()),
  cumulativeYtd: z.object({
    periodLabel: z.string().min(1),
    revenueGrowthYoy: numberSchema.optional(),
    netIncomeGrowthYoy: numberSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

const screenerResultSchema = z.object({
  ticker: z.string().min(1),
  name: z.string().optional(),
  roe: numberSchema.optional(),
  revenueGrowthYoy: numberSchema.optional(),
  netIncomeGrowthYoy: numberSchema.optional(),
  pe: numberSchema.optional(),
  pb: numberSchema.optional(),
  matchScore: numberSchema,
}).passthrough();

const dailyTransactionSchema = z.object({
  ticker: z.string().min(1),
  asOf: z.string().min(1),
  window: z.string().min(1),
  avgValueBillion: numberSchema.optional(),
  volumeRatio: numberSchema.optional(),
  upDaysPct: numberSchema.optional(),
  avgIntradayVolatilityPct: numberSchema.optional(),
  liquidityBand: z.enum(['high', 'moderate', 'low']).optional(),
}).passthrough();

const foreignFlowSchema = z.object({
  ticker: z.string().min(1),
  asOf: z.string().min(1),
  window: z.string().min(1),
  netForeignPctOfCap: numberSchema.optional(),
  netFlow: z.enum(['buy', 'sell', 'neutral']).optional(),
  netBuyDaysPct: numberSchema.optional(),
}).passthrough();

const newsArticleSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().min(1),
  headline: z.string(),
  url: z.string().optional(),
  publishedAt: z.string().min(1),
  snippet: z.string(),
  sentiment: z.enum(['positive', 'negative', 'neutral']).optional(),
  source: z.string().optional(),
}).passthrough();

const filingSchema = z.object({
  id: z.string().min(1),
  ticker: z.string().min(1),
  type: z.string().min(1),
  title: z.string(),
  filedAt: z.string().min(1),
  url: z.string().optional(),
}).passthrough();

const sentimentSchema = z.object({
  ticker: z.string().min(1),
  asOf: z.string().min(1),
  window: z.string().min(1),
  aggregate: numberSchema.optional(),
  distribution: z.object({
    positive: numberSchema,
    negative: numberSchema,
    neutral: numberSchema,
  }).passthrough().optional(),
  articleCount: numberSchema.optional(),
}).passthrough();

function financialDataResultSchema<T>(dataSchema: z.ZodType<T>): z.ZodType<FinancialDataResult<T>> {
  return z.object({
    data: dataSchema,
    metadata: financialMetadataSchema,
  }).passthrough() as z.ZodType<FinancialDataResult<T>>;
}

const tickerInputSchema = z.object({ ticker: z.string().min(1) });
const screenInputSchema = z.object({ criteria: z.array(z.string()) });

export const financialToolIds = {
  companyReport: 'financial.company-report',
  quarterlyFinancials: 'financial.quarterly-financials',
  screen: 'financial.screen',
  dailyTransaction: 'financial.daily-transaction',
  foreignFlow: 'financial.foreign-flow',
  news: 'financial.news',
  filings: 'financial.filings',
  sentiment: 'financial.sentiment',
} as const;

export function createFinancialTools(provider: FinancialDataProvider) {
  return {
    companyReport: defineTool({
      id: financialToolIds.companyReport,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<CompanyReport>(companyReportSchema),
      execute: ({ ticker }) => provider.getCompanyReport(ticker),
    }),
    quarterlyFinancials: defineTool({
      id: financialToolIds.quarterlyFinancials,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<QuarterlyFinancials>(quarterlyFinancialsSchema),
      execute: ({ ticker }) => provider.getQuarterlyFinancials(ticker),
    }),
    screen: defineTool({
      id: financialToolIds.screen,
      inputSchema: screenInputSchema,
      outputSchema: z.array(screenerResultSchema),
      execute: ({ criteria }) => provider.screen(criteria),
    }),
    dailyTransaction: defineTool({
      id: financialToolIds.dailyTransaction,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<DailyTransaction>(dailyTransactionSchema),
      execute: ({ ticker }) => provider.getDailyTransaction(ticker),
    }),
    foreignFlow: defineTool({
      id: financialToolIds.foreignFlow,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<ForeignFlow>(foreignFlowSchema),
      execute: ({ ticker }) => provider.getForeignFlow(ticker),
    }),
    news: defineTool({
      id: financialToolIds.news,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<NewsArticle[]>(z.array(newsArticleSchema)),
      execute: ({ ticker }) => provider.getNews(ticker),
    }),
    filings: defineTool({
      id: financialToolIds.filings,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<Filing[]>(z.array(filingSchema)),
      execute: ({ ticker }) => provider.getFilings(ticker),
    }),
    sentiment: defineTool({
      id: financialToolIds.sentiment,
      inputSchema: tickerInputSchema,
      outputSchema: financialDataResultSchema<Sentiment>(sentimentSchema),
      execute: ({ ticker }) => provider.getSentiment(ticker),
    }),
  } as const;
}

export type FinancialTools = ReturnType<typeof createFinancialTools>;
