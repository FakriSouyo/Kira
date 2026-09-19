import { createHash } from 'node:crypto';
import type {
  CompanyReport,
  DailyTransaction,
  Filing,
  ForeignFlow,
  NewsArticle,
  QuarterlyFinancials,
  Sentiment,
} from './types';
import type { FinancialDataMetadata, FinancialDataResult } from './provider';

export const FINANCIAL_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const FINANCIAL_OBSERVATION_KINDS = [
  'company_report',
  'quarterly_financials',
  'daily_transaction',
  'foreign_flow',
  'news',
  'filings',
  'sentiment',
] as const;

export type FinancialObservationKind = typeof FINANCIAL_OBSERVATION_KINDS[number];
export type FinancialObservationStatus = 'PRESENT' | 'NOT_REQUESTED' | 'UNAVAILABLE';
export type FinancialSnapshotCompleteness = 'COMPLETE' | 'PARTIAL';

export interface FinancialDataByKind {
  company_report: CompanyReport;
  quarterly_financials: QuarterlyFinancials;
  daily_transaction: DailyTransaction;
  foreign_flow: ForeignFlow;
  news: NewsArticle[];
  filings: Filing[];
  sentiment: Sentiment;
}

export interface ObservationVerification {
  schema: 'PASS';
  subject: 'PASS';
  provenance: 'PASS';
  temporal: 'PASS' | 'UNKNOWN';
}

export interface PresentFinancialObservation<K extends FinancialObservationKind = FinancialObservationKind> {
  kind: K;
  status: 'PRESENT';
  data: FinancialDataByKind[K];
  metadata: FinancialDataMetadata;
  verification: ObservationVerification;
  evidenceIds: string[];
}

export type FinancialObservation = PresentFinancialObservation | UnavailableFinancialObservation | NotRequestedFinancialObservation;

export interface UnavailableFinancialObservation {
  kind: FinancialObservationKind;
  status: 'UNAVAILABLE';
  reason: 'PROVIDER_ERROR' | 'VERIFICATION_FAILED' | 'CANCELLED' | 'PERSISTENCE_ERROR';
  errorCode?: string;
}

export interface NotRequestedFinancialObservation {
  kind: FinancialObservationKind;
  status: 'NOT_REQUESTED';
  reason: 'PROFILE_DISABLED';
}

export interface VerifiedFinancialSnapshot {
  snapshotId: string;
  schemaVersion: typeof FINANCIAL_SNAPSHOT_SCHEMA_VERSION;
  sessionId: string;
  turnId: string;
  executionId: string;
  subject: { ticker: string };
  requestedAsOf: string | null;
  executionStartedAt: string;
  completeness: FinancialSnapshotCompleteness;
  observations: readonly FinancialObservation[];
  materializedEvidenceIds: readonly string[];
  fingerprint: string;
  createdAt: string;
  finalizedAt: string;
}

export interface FinancialSnapshotStore {
  save(snapshot: VerifiedFinancialSnapshot): Promise<VerifiedFinancialSnapshot>;
  getById(snapshotId: string): Promise<VerifiedFinancialSnapshot | null>;
  getByExecutionId(executionId: string): Promise<VerifiedFinancialSnapshot | null>;
}

export class FinancialSnapshotConflictError extends Error {
  readonly code = 'FINANCIAL_SNAPSHOT_CONFLICT';

  constructor(snapshotId: string, message: string) {
    super(message);
    this.name = 'FinancialSnapshotConflictError';
    this.snapshotId = snapshotId;
  }

  readonly snapshotId: string;
}

export interface CreateVerifiedFinancialSnapshotParams {
  sessionId: string;
  turnId: string;
  executionId: string;
  ticker: string;
  requestedAsOf?: string | null;
  executionStartedAt: string;
  finalizedAt: string;
  observations: readonly FinancialObservation[];
  materializedEvidenceIds: readonly string[];
}

export class FinancialDataVerificationError extends Error {
  readonly code = 'FINANCIAL_DATA_VERIFICATION_FAILED';

  constructor(
    readonly kind: FinancialObservationKind,
    readonly reason: 'SCHEMA' | 'SUBJECT' | 'PROVENANCE' | 'TEMPORAL',
    message: string,
  ) {
    super(message);
    this.name = 'FinancialDataVerificationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteOptional(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isStringOptional(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCompanyReport(value: unknown): value is CompanyReport {
  if (!isRecord(value) || typeof value.ticker !== 'string') return false;
  const financials = value.financials;
  const valuation = value.valuation;
  if (!isRecord(financials) || !isRecord(valuation)) return false;
  const financialKeys = ['roe', 'roa', 'netMargin', 'grossMargin', 'debtToEquity', 'currentRatio', 'yoyQuarterRevenueGrowth', 'yoyQuarterEarningsGrowth'];
  const valuationKeys = ['price', 'pe', 'pb', 'dividendYield'];
  return isStringOptional(value.name) && isStringOptional(value.sector) && isStringOptional(value.asOf)
    && financialKeys.every(key => isFiniteOptional(financials[key]))
    && valuationKeys.every(key => isFiniteOptional(valuation[key]));
}

function isQuarterlyFinancials(value: unknown): value is QuarterlyFinancials {
  if (!isRecord(value) || typeof value.ticker !== 'string' || !Array.isArray(value.quarters)) return false;
  const quarters = value.quarters.every((quarter) => {
    if (!isRecord(quarter) || typeof quarter.period !== 'string' || typeof quarter.revenue !== 'number' || !Number.isFinite(quarter.revenue)
      || typeof quarter.netIncome !== 'number' || !Number.isFinite(quarter.netIncome)) return false;
    return isStringOptional(quarter.periodType) && isFiniteOptional(quarter.revenueGrowthYoy) && isFiniteOptional(quarter.netIncomeGrowthYoy);
  });
  const cumulative = value.cumulativeYtd;
  return quarters && (cumulative === undefined || (
    isRecord(cumulative) && typeof cumulative.periodLabel === 'string'
    && isFiniteOptional(cumulative.revenueGrowthYoy) && isFiniteOptional(cumulative.netIncomeGrowthYoy)
  ));
}

function isDailyTransaction(value: unknown): value is DailyTransaction {
  if (!isRecord(value) || typeof value.ticker !== 'string' || typeof value.asOf !== 'string' || typeof value.window !== 'string') return false;
  return ['avgValueBillion', 'volumeRatio', 'upDaysPct', 'avgIntradayVolatilityPct'].every(key => isFiniteOptional(value[key]))
    && (value.liquidityBand === undefined || value.liquidityBand === 'high' || value.liquidityBand === 'moderate' || value.liquidityBand === 'low');
}

function isForeignFlow(value: unknown): value is ForeignFlow {
  if (!isRecord(value) || typeof value.ticker !== 'string' || typeof value.asOf !== 'string' || typeof value.window !== 'string') return false;
  return ['netForeignPctOfCap', 'netBuyDaysPct'].every(key => isFiniteOptional(value[key]))
    && (value.netFlow === undefined || value.netFlow === 'buy' || value.netFlow === 'sell' || value.netFlow === 'neutral');
}

function isNews(value: unknown): value is NewsArticle[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.id === 'string' && typeof item.ticker === 'string' && typeof item.headline === 'string'
    && isStringOptional(item.url) && typeof item.publishedAt === 'string' && typeof item.snippet === 'string'
    && isStringOptional(item.source)
    && (item.sentiment === undefined || item.sentiment === 'positive' || item.sentiment === 'negative' || item.sentiment === 'neutral'));
}

function isFilings(value: unknown): value is Filing[] {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.id === 'string' && typeof item.ticker === 'string' && typeof item.type === 'string'
    && typeof item.title === 'string' && typeof item.filedAt === 'string' && isStringOptional(item.url));
}

function isSentiment(value: unknown): value is Sentiment {
  if (!isRecord(value) || typeof value.ticker !== 'string' || typeof value.asOf !== 'string' || typeof value.window !== 'string'
    || !isFiniteOptional(value.aggregate) || !isFiniteOptional(value.articleCount)) return false;
  const distribution = value.distribution;
  return distribution === undefined || (isRecord(distribution)
    && typeof distribution.positive === 'number' && Number.isFinite(distribution.positive)
    && typeof distribution.negative === 'number' && Number.isFinite(distribution.negative)
    && typeof distribution.neutral === 'number' && Number.isFinite(distribution.neutral));
}

function schemaValid(kind: FinancialObservationKind, value: unknown): boolean {
  switch (kind) {
    case 'company_report': return isCompanyReport(value);
    case 'quarterly_financials': return isQuarterlyFinancials(value);
    case 'daily_transaction': return isDailyTransaction(value);
    case 'foreign_flow': return isForeignFlow(value);
    case 'news': return isNews(value);
    case 'filings': return isFilings(value);
    case 'sentiment': return isSentiment(value);
  }
}

function tickersOf(kind: FinancialObservationKind, value: FinancialDataByKind[FinancialObservationKind]): string[] {
  if (kind === 'news') return (value as NewsArticle[]).map(item => item.ticker);
  if (kind === 'filings') return (value as Filing[]).map(item => item.ticker);
  return [(value as { ticker: string }).ticker];
}

function validDate(value: string | null): boolean {
  return value === null || Number.isFinite(new Date(value).getTime());
}

function assertMetadata(kind: FinancialObservationKind, metadata: FinancialDataMetadata): void {
  if (!metadata || typeof metadata.providerId !== 'string' || metadata.providerId.length === 0
    || typeof metadata.source !== 'string' || metadata.source.length === 0
    || !['PROVIDER', 'CACHE', 'MOCK', 'DERIVED'].includes(metadata.origin)
    || !Array.isArray(metadata.derivedFrom)
    || metadata.derivedFrom.some(value => !FINANCIAL_OBSERVATION_KINDS.includes(value))) {
    throw new FinancialDataVerificationError(kind, 'PROVENANCE', `Financial observation ${kind} is missing provider provenance`);
  }
  if (metadata.origin === 'DERIVED' && metadata.derivedFrom.length === 0) {
    throw new FinancialDataVerificationError(kind, 'PROVENANCE', `Derived financial observation ${kind} is missing lineage`);
  }
  if (!validDate(metadata.fetchedAt) || !validDate(metadata.dataAsOf) || !validDate(metadata.requestedAsOf)) {
    throw new FinancialDataVerificationError(kind, 'PROVENANCE', `Financial observation ${kind} has invalid metadata dates`);
  }
}

function temporalStatus<K extends FinancialObservationKind>(kind: K, metadata: FinancialDataMetadata): 'PASS' | 'UNKNOWN' {
  if (metadata.requestedAsOf === null) return 'PASS';
  if (metadata.dataAsOf === null) return 'UNKNOWN';
  if (new Date(metadata.dataAsOf).getTime() > new Date(metadata.requestedAsOf).getTime()) {
    throw new FinancialDataVerificationError(kind, 'TEMPORAL', `Financial observation ${kind} is after the requested cutoff`);
  }
  return 'PASS';
}

export function verifyFinancialObservation<K extends FinancialObservationKind>(
  kind: K,
  result: FinancialDataResult<FinancialDataByKind[K]>,
  expectedTicker: string,
): PresentFinancialObservation<K> {
  if (!schemaValid(kind, result.data)) {
    throw new FinancialDataVerificationError(kind, 'SCHEMA', `Financial observation ${kind} has an incompatible shape`);
  }
  assertMetadata(kind, result.metadata);
  const expected = expectedTicker.toUpperCase();
  if (tickersOf(kind, result.data).some(ticker => ticker.toUpperCase() !== expected)) {
    throw new FinancialDataVerificationError(kind, 'SUBJECT', `Financial observation ${kind} does not match ticker ${expected}`);
  }
  return {
    kind,
    status: 'PRESENT',
    data: result.data,
    metadata: result.metadata,
    verification: { schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: temporalStatus(kind, result.metadata) },
    evidenceIds: [],
  };
}

export function createNotRequestedObservation(kind: FinancialObservationKind): NotRequestedFinancialObservation {
  return { kind, status: 'NOT_REQUESTED', reason: 'PROFILE_DISABLED' };
}

export function createUnavailableObservation(
  kind: FinancialObservationKind,
  reason: UnavailableFinancialObservation['reason'],
  errorCode?: string,
): UnavailableFinancialObservation {
  return { kind, status: 'UNAVAILABLE', reason, ...(errorCode ? { errorCode } : {}) };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = sortKeys((value as Record<string, unknown>)[key]);
      return result;
    }, {});
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

export function freezeVerifiedFinancialSnapshot(snapshot: VerifiedFinancialSnapshot): VerifiedFinancialSnapshot {
  return deepFreeze(snapshot);
}

function semanticPayload(snapshot: Pick<VerifiedFinancialSnapshot, 'schemaVersion' | 'sessionId' | 'turnId' | 'executionId' | 'subject' | 'requestedAsOf' | 'executionStartedAt' | 'completeness' | 'observations' | 'materializedEvidenceIds'>): unknown {
  return {
    schemaVersion: snapshot.schemaVersion,
    sessionId: snapshot.sessionId,
    turnId: snapshot.turnId,
    executionId: snapshot.executionId,
    subject: snapshot.subject,
    requestedAsOf: snapshot.requestedAsOf,
    executionStartedAt: snapshot.executionStartedAt,
    completeness: snapshot.completeness,
    observations: snapshot.observations,
    materializedEvidenceIds: snapshot.materializedEvidenceIds,
  };
}

export function financialSnapshotSemanticJson(snapshot: VerifiedFinancialSnapshot): string {
  return canonicalJson(semanticPayload(snapshot));
}

export function createVerifiedFinancialSnapshot(params: CreateVerifiedFinancialSnapshotParams): VerifiedFinancialSnapshot {
  if (!params.sessionId || !params.turnId || !params.executionId || !params.ticker) throw new Error('Financial snapshot lifecycle identity is required');
  if (!validDate(params.executionStartedAt) || !validDate(params.finalizedAt) || (params.requestedAsOf !== undefined && !validDate(params.requestedAsOf))) {
    throw new Error('Financial snapshot timestamps must be valid ISO dates');
  }
  const byKind = new Map(params.observations.map(observation => [observation.kind, observation]));
  if (byKind.size !== FINANCIAL_OBSERVATION_KINDS.length) throw new Error('Financial snapshot must contain exactly one observation per kind');
  for (const kind of FINANCIAL_OBSERVATION_KINDS) {
    if (!byKind.has(kind)) throw new Error(`Financial snapshot is missing ${kind}`);
  }
  const company = byKind.get('company_report');
  const quarterly = byKind.get('quarterly_financials');
  if (company?.status !== 'PRESENT' || quarterly?.status !== 'PRESENT') {
    throw new Error('Financial snapshot requires verified company_report and quarterly_financials observations');
  }
  const observations = FINANCIAL_OBSERVATION_KINDS.map(kind => byKind.get(kind)!);
  const completeness: FinancialSnapshotCompleteness = observations.every(observation => observation.status === 'PRESENT') ? 'COMPLETE' : 'PARTIAL';
  const base = {
    schemaVersion: FINANCIAL_SNAPSHOT_SCHEMA_VERSION,
    sessionId: params.sessionId,
    turnId: params.turnId,
    executionId: params.executionId,
    subject: { ticker: params.ticker.toUpperCase() },
    requestedAsOf: params.requestedAsOf ?? null,
    executionStartedAt: params.executionStartedAt,
    completeness,
    observations: structuredClone(observations),
    materializedEvidenceIds: structuredClone([...params.materializedEvidenceIds]),
  } as const;
  const fingerprint = digest(base);
  const snapshotId = `financial_snapshot_${digest({ executionId: params.executionId, fingerprint })}`;
  return freezeVerifiedFinancialSnapshot({
    ...base,
    snapshotId,
    fingerprint,
    createdAt: params.finalizedAt,
    finalizedAt: params.finalizedAt,
  });
}
