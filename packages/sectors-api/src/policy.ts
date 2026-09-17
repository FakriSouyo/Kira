import { createHash } from 'node:crypto';
import type { CacheEntry } from './cache';

export type SectorsSubjectScope = 'symbol' | 'shared';

export type SectorsTemporalKind =
  | 'mixed_snapshot'
  | 'latest_period'
  | 'historical_period'
  | 'historical_range'
  | 'recent_snapshot'
  | 'event_revalidation';

/**
 * Normalized provider requirement. Context identifies the consumer only; it is
 * deliberately excluded from the provider-data cache identity.
 */
export interface SectorsCacheRequirement {
  provider: 'sectors-api';
  operation: string;
  subjectScope: SectorsSubjectScope;
  subject?: string;
  params: Record<string, unknown>;
  temporal: { kind: SectorsTemporalKind; period?: string; asOf?: string };
  schemaVersion: number;
  adapterVersion: string;
  context?: {
    workflow?: string;
    command?: string;
    turnId?: string;
    executionId?: string;
    runId?: string;
  };
}

export type CacheDecisionReason =
  | 'missing'
  | 'fresh'
  | 'stale'
  | 'latest_revalidation_due'
  | 'incompatible_identity'
  | 'incompatible_schema';

export interface CacheDecision {
  action: 'reuse' | 'fetch';
  reason: CacheDecisionReason;
  key: string;
  operation: string;
  subjectScope: SectorsSubjectScope;
  subject?: string;
}

export interface CacheDecisionOptions {
  now?: Date;
  ttlMs?: number;
  newsTtlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 3_600_000;
const DEFAULT_NEWS_TTL_MS = 3_600_000;

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, normalizeValue(entry)]),
    );
  }
  return value;
}

/** Canonical identity material; command/workflow/Turn/Execution/run are absent. */
export function normalizedRequirement(requirement: SectorsCacheRequirement): Record<string, unknown> {
  const subject = requirement.subjectScope === 'symbol' && requirement.subject
    ? requirement.subject.toUpperCase()
    : undefined;
  return normalizeValue({
    provider: requirement.provider,
    operation: requirement.operation,
    subjectScope: requirement.subjectScope,
    subject,
    params: requirement.params,
    temporal: requirement.temporal,
    schemaVersion: requirement.schemaVersion,
    adapterVersion: requirement.adapterVersion,
  }) as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeValue(value));
}

/** Stable file-safe key for one normalized provider requirement. */
export function cacheKeyFor(requirement: SectorsCacheRequirement): string {
  const normalized = normalizedRequirement(requirement);
  const digest = createHash('sha256').update(canonicalJson(normalized)).digest('hex').slice(0, 20);
  const subject = requirement.subjectScope === 'symbol' && requirement.subject
    ? requirement.subject.toUpperCase()
    : 'shared';
  return `sectors_${requirement.operation}_${subject}_${digest}`;
}

function isSameLocalCalendarDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function ttlFor(requirement: SectorsCacheRequirement, options: CacheDecisionOptions): number {
  if (requirement.operation === 'news' || requirement.operation === 'filings') {
    return options.newsTtlMs ?? DEFAULT_NEWS_TTL_MS;
  }
  return options.ttlMs ?? DEFAULT_TTL_MS;
}

function isFresh(requirement: SectorsCacheRequirement, entry: CacheEntry<unknown>, now: Date, options: CacheDecisionOptions): boolean {
  const fetchedAt = new Date(entry.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime())) return false;
  if (requirement.temporal.kind === 'historical_range') return isSameLocalCalendarDay(now, fetchedAt);
  return now.getTime() - fetchedAt.getTime() < ttlFor(requirement, options);
}

/** Evaluate a disk entry without ever reusing an incompatible or corrupt entry. */
export function evaluateCacheEntry(
  requirement: SectorsCacheRequirement,
  entry: CacheEntry<unknown> | null,
  options: CacheDecisionOptions = {},
): CacheDecision {
  const key = cacheKeyFor(requirement);
  const base = {
    key,
    operation: requirement.operation,
    subjectScope: requirement.subjectScope,
    ...(requirement.subjectScope === 'symbol' && requirement.subject ? { subject: requirement.subject.toUpperCase() } : {}),
  } satisfies Omit<CacheDecision, 'action' | 'reason'>;
  if (!entry) return { action: 'fetch', reason: 'missing', ...base };
  if (entry.meta?.cacheIdentity !== key) return { action: 'fetch', reason: 'incompatible_identity', ...base };
  if (entry.meta.schemaVersion !== requirement.schemaVersion || entry.meta.adapterVersion !== requirement.adapterVersion) {
    return { action: 'fetch', reason: 'incompatible_schema', ...base };
  }
  if (requirement.temporal.kind === 'historical_period' && entry.meta.period !== requirement.temporal.period) {
    return { action: 'fetch', reason: 'incompatible_identity', ...base };
  }
  const now = options.now ?? new Date();
  if (!isFresh(requirement, entry, now, options)) {
    const reason = requirement.temporal.kind === 'latest_period' ? 'latest_revalidation_due' : 'stale';
    return { action: 'fetch', reason, ...base };
  }
  return { action: 'reuse', reason: 'fresh', ...base };
}
