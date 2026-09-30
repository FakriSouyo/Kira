import {
  verifyFinancialObservation,
  type CompanyReport,
  type FinancialDataMetadata,
  type FinancialObservationKind,
  type QuarterlyFinancials,
  type QuarterlyGrowthMetric,
} from '@harness/financial-data';
import { EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID, type EvidenceStore } from '@harness/evidence';
import {
  ComparisonMatrixSchema,
  type ComparisonCell,
  type ComparisonDifference,
  type ComparisonMatrix,
  type ComparisonMetric,
  type ComparisonSourceReference,
  type ComparisonSubject,
  type ComparisonWarning,
} from '@harness/schemas';
import { canonicalJson } from '@harness/shared';

const METRICS: readonly QuarterlyGrowthMetric[] = ['revenueGrowthYoy', 'netIncomeGrowthYoy'];
const TICKER_PATTERN = /^[A-Z]{2,6}$/;
const PERIOD_PATTERN = /^(\d{4})-Q([1-4])$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ComparisonNormalizationErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_EVIDENCE'
  | 'INVALID_PERIODS'
  | 'NO_COMMON_COMPARABLE_PERIOD'
  | 'NO_COMPARABLE_METRICS'
  | 'VALIDATION_UNAVAILABLE'
  | 'CANCELLED';

export class ComparisonNormalizationError extends Error {
  readonly code: ComparisonNormalizationErrorCode;
  readonly cause?: unknown;

  constructor(code: ComparisonNormalizationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ComparisonNormalizationError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface ComparisonEvidenceSource {
  readonly ticker: string;
  readonly companyReportEvidenceId: string;
  readonly quarterlyFinancialsEvidenceId: string;
}

export interface NormalizeComparisonEvidenceParams {
  readonly executionId: string;
  readonly subjects: readonly string[];
  readonly sources: readonly ComparisonEvidenceSource[];
  readonly evidenceStore: Pick<EvidenceStore, 'getManyByIdsForRun'>;
  readonly signal?: AbortSignal;
}

interface ValidatedSubjectEvidence {
  readonly ticker: string;
  readonly reportEvidenceId: string;
  readonly quarterlyEvidenceId: string;
  readonly report: CompanyReport;
  readonly reportMetadata: FinancialDataMetadata;
  readonly quarterly: QuarterlyFinancials;
}

function fail(code: ComparisonNormalizationErrorCode, message: string): never {
  throw new ComparisonNormalizationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalPeriod(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = PERIOD_PATTERN.exec(value);
  return match !== null && Number(match[1]) >= 1;
}

function periodOrdinal(period: string): number {
  const match = PERIOD_PATTERN.exec(period)!;
  return Number(match[1]) * 4 + Number(match[2]);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ComparisonNormalizationError('CANCELLED', 'Comparison normalization was cancelled');
}

function validateInputs(params: NormalizeComparisonEvidenceParams): {
  executionId: string;
  tickers: string[];
  mappings: Array<{ ticker: string; reportId: string; quarterlyId: string }>;
  requestedIds: string[];
} {
  if (typeof params.executionId !== 'string' || params.executionId.trim().length === 0) {
    fail('INVALID_INPUT', 'Comparison executionId must be a nonblank string');
  }
  const executionId = params.executionId.trim();
  if (!Array.isArray(params.subjects) || params.subjects.length < 2 || params.subjects.length > 3) {
    fail('INVALID_INPUT', 'Comparison requires two or three subjects');
  }
  const tickers = params.subjects.map((raw) => {
    if (typeof raw !== 'string') fail('INVALID_INPUT', 'Comparison ticker must be a string');
    const ticker = raw.trim().toUpperCase();
    if (!TICKER_PATTERN.test(ticker)) fail('INVALID_INPUT', `Invalid comparison ticker: ${raw}`);
    return ticker;
  });
  if (new Set(tickers).size !== tickers.length) fail('INVALID_INPUT', 'Comparison subjects must be unique after normalization');
  if (!Array.isArray(params.sources) || params.sources.length !== tickers.length) {
    fail('INVALID_INPUT', 'Comparison requires exactly one source mapping per subject');
  }

  const mappings = params.sources.map((source, index) => {
    if (!isRecord(source)) fail('INVALID_INPUT', 'Comparison source mapping must be an object');
    const ticker = typeof source.ticker === 'string' ? source.ticker.trim().toUpperCase() : '';
    if (ticker !== tickers[index]) fail('INVALID_INPUT', 'Comparison source mapping order must match normalized subjects');
    const reportId = typeof source.companyReportEvidenceId === 'string' ? source.companyReportEvidenceId.toLowerCase() : '';
    const quarterlyId = typeof source.quarterlyFinancialsEvidenceId === 'string' ? source.quarterlyFinancialsEvidenceId.toLowerCase() : '';
    if (!UUID_PATTERN.test(reportId) || !UUID_PATTERN.test(quarterlyId)) fail('INVALID_INPUT', 'Comparison source IDs must be UUIDs');
    return { ticker, reportId, quarterlyId };
  });
  const requestedIds = mappings.flatMap(mapping => [mapping.reportId, mapping.quarterlyId]);
  if (new Set(requestedIds).size !== requestedIds.length) fail('INVALID_INPUT', 'Comparison Evidence IDs must be unique across subjects and source kinds');
  return { executionId, tickers, mappings, requestedIds };
}

function validateQuarterPeriods(ticker: string, quarterly: QuarterlyFinancials): Map<string, number> {
  const indexes = new Map<string, number>();
  for (const [index, quarter] of quarterly.quarters.entries()) {
    if (!canonicalPeriod(quarter.period)) {
      throw new ComparisonNormalizationError('INVALID_PERIODS', `Quarterly Evidence for ${ticker} has a noncanonical period`);
    }
    if (indexes.has(quarter.period)) {
      throw new ComparisonNormalizationError('INVALID_PERIODS', `Quarterly Evidence for ${ticker} contains duplicate period ${quarter.period}`);
    }
    if (quarter.periodType !== undefined && quarter.periodType !== 'single_quarter') {
      throw new ComparisonNormalizationError('INVALID_PERIODS', `Quarterly Evidence for ${ticker} has unsupported periodType`);
    }
    indexes.set(quarter.period, index);
  }
  return indexes;
}

function provenanceOf(evidence: Record<string, unknown>, expectedKind: FinancialObservationKind, ticker: string): {
  metadata: FinancialDataMetadata;
  verification: Record<string, unknown>;
} {
  const acceptance = evidence.acceptance;
  const provenance = evidence.provenance;
  if (!isRecord(acceptance) || acceptance.legacy === true || acceptance.candidateKind !== 'financial'
    || acceptance.policyId !== EVIDENCE_POLICY_ID || acceptance.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT
    || typeof acceptance.acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptance.acceptedAt))
    || acceptance.validAt !== null || (evidence.validAt !== undefined && evidence.validAt !== null)
    || typeof acceptance.provenance !== 'object' || acceptance.provenance === null || Array.isArray(acceptance.provenance)
    || typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) {
    throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence for ${ticker} has no current financial acceptance receipt`);
  }
  if (canonicalJson(provenance) !== canonicalJson(acceptance.provenance)) {
    throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence for ${ticker} has conflicting provenance copies`);
  }
  const receipt = acceptance.provenance as Record<string, unknown>;
  if (receipt.observationKind !== expectedKind || !isRecord(receipt.metadata) || !isRecord(receipt.verification)) {
    throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence for ${ticker} has mismatched observation provenance`);
  }
  const metadata = receipt.metadata as unknown as FinancialDataMetadata;
  const verification = receipt.verification;
  if (typeof metadata.source !== 'string' || evidence.source !== metadata.source || acceptance.sourceOrigin !== metadata.origin
    || acceptance.retrievedAt !== metadata.fetchedAt || acceptance.validAt !== (evidence.validAt ?? null)) {
    throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence for ${ticker} has inconsistent source metadata`);
  }
  return { metadata, verification };
}

function validateEvidence(params: {
  records: unknown[];
  executionId: string;
  mappings: Array<{ ticker: string; reportId: string; quarterlyId: string }>;
  requestedIds: string[];
}): ValidatedSubjectEvidence[] {
  if (!Array.isArray(params.records)) fail('INVALID_EVIDENCE', 'Scoped Evidence lookup returned a non-array result');
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of params.records) {
    if (!isRecord(item) || typeof item.id !== 'string' || !UUID_PATTERN.test(item.id)) {
      fail('INVALID_EVIDENCE', 'Scoped Evidence lookup returned a malformed record');
    }
    const id = item.id.toLowerCase();
    if (byId.has(id)) fail('INVALID_EVIDENCE', 'Scoped Evidence lookup returned a duplicate ID');
    byId.set(id, item);
  }
  if (byId.size !== params.requestedIds.length || params.requestedIds.some(id => !byId.has(id))) {
    fail('INVALID_EVIDENCE', 'Scoped Evidence lookup did not return exactly the requested Evidence IDs');
  }

  const accepted = new Map<string, { item: Record<string, unknown>; kind: FinancialObservationKind; metadata: FinancialDataMetadata }>();
  for (const mapping of params.mappings) {
    for (const [id, kind] of [
      [mapping.reportId, 'company_report'],
      [mapping.quarterlyId, 'quarterly_financials'],
    ] as const) {
      const item = byId.get(id)!;
      if (item.id?.toString().toLowerCase() !== id || item.runId !== params.executionId
        || typeof item.ticker !== 'string' || item.ticker.trim().toUpperCase() !== mapping.ticker) {
        throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence ${id} is outside the requested Execution or subject`);
      }
      const { metadata, verification } = provenanceOf(item, kind, mapping.ticker);
      if (canonicalJson(verification) !== canonicalJson({ schema: 'PASS', subject: 'PASS', provenance: 'PASS', temporal: verification.temporal })) {
        throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence for ${mapping.ticker} has an invalid verification receipt`);
      }
      try {
        const observed = kind === 'company_report'
          ? verifyFinancialObservation('company_report', { data: item.data as CompanyReport, metadata }, mapping.ticker)
          : verifyFinancialObservation('quarterly_financials', { data: item.data as QuarterlyFinancials, metadata }, mapping.ticker);
        if (canonicalJson(observed.verification) !== canonicalJson(verification)) {
          throw new Error('Persisted verification does not match the financial verifier');
        }
      } catch (error) {
        throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Evidence for ${mapping.ticker} failed financial verification`, error);
      }
      accepted.set(id, { item, kind, metadata });
    }
  }

  return params.mappings.map((mapping) => {
    const report = accepted.get(mapping.reportId)!;
    const quarterly = accepted.get(mapping.quarterlyId)!;
    return {
      ticker: mapping.ticker,
      reportEvidenceId: mapping.reportId,
      quarterlyEvidenceId: mapping.quarterlyId,
      report: report.item.data as unknown as CompanyReport,
      reportMetadata: report.metadata,
      quarterly: quarterly.item.data as unknown as QuarterlyFinancials,
    };
  });
}

function hasValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseIsoInstant(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !hasValidCalendarDate(match[1]!)) return null;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = match[5]!;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const candidate = value.trim();
  if (hasValidCalendarDate(candidate)) return candidate;
  const timestamp = parseIsoInstant(candidate);
  return timestamp === null ? null : new Date(timestamp).toISOString().slice(0, 10);
}

function normalizedInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const timestamp = parseIsoInstant(value.trim());
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString();
}

function buildFreshnessWarnings(subjects: readonly ValidatedSubjectEvidence[]): ComparisonWarning[] {
  const warnings: ComparisonWarning[] = [];
  const mismatchedTickers = new Set<string>();
  const asOfDates = new Map<string, string | null>();
  const metadataDates = new Map<string, string | null>();
  const acquisitionTimes = new Map<string, string | null>();
  for (const subject of subjects) {
    const asOf = normalizedDate(subject.report.asOf);
    const dataAsOf = normalizedDate(subject.reportMetadata.dataAsOf);
    const fetchedAt = normalizedInstant(subject.reportMetadata.fetchedAt);
    asOfDates.set(subject.ticker, asOf);
    metadataDates.set(subject.ticker, dataAsOf);
    acquisitionTimes.set(subject.ticker, fetchedAt);
    if (!asOf || !dataAsOf || !fetchedAt) warnings.push({ code: 'COMPANY_REPORT_FRESHNESS_UNKNOWN', ticker: subject.ticker });
    if (asOf && dataAsOf && asOf !== dataAsOf) mismatchedTickers.add(subject.ticker);
  }
  for (const timestamps of [asOfDates, metadataDates, acquisitionTimes]) {
    const knownValues = new Set([...timestamps.values()].filter((value): value is string => value !== null));
    if (knownValues.size > 1) {
      for (const [ticker, timestamp] of timestamps) if (timestamp !== null) mismatchedTickers.add(ticker);
    }
  }
  if (mismatchedTickers.size > 0) {
    warnings.push({
      code: 'COMPANY_REPORT_TIMESTAMP_MISMATCH',
      tickers: subjects.map(subject => subject.ticker).filter(ticker => mismatchedTickers.has(ticker)),
    });
  }
  return warnings;
}

function sourceReference(evidenceId: string, path: string, periodLabel: string): ComparisonSourceReference {
  return { evidenceId, path, periodLabel };
}

/** Deterministically normalizes only verified, execution-scoped quarterly growth Evidence. */
export async function normalizeComparisonEvidence(params: NormalizeComparisonEvidenceParams): Promise<ComparisonMatrix> {
  const validatedInput = validateInputs(params);
  assertNotAborted(params.signal);

  let records: unknown[];
  try {
    records = await params.evidenceStore.getManyByIdsForRun(validatedInput.executionId, validatedInput.requestedIds);
  } catch (cause) {
    if (params.signal?.aborted) assertNotAborted(params.signal);
    throw new ComparisonNormalizationError('VALIDATION_UNAVAILABLE', 'Execution-scoped Evidence could not be read', cause);
  }
  assertNotAborted(params.signal);

  const acceptedSubjects = validateEvidence({
    records,
    executionId: validatedInput.executionId,
    mappings: validatedInput.mappings,
    requestedIds: validatedInput.requestedIds,
  });
  const quarterIndexes = acceptedSubjects.map(subject => validateQuarterPeriods(subject.ticker, subject.quarterly));
  const eligiblePeriods = acceptedSubjects.map(subject => new Set(
    subject.quarterly.quarters
      .filter(quarter => quarter.periodType === 'single_quarter')
      .map(quarter => quarter.period),
  ));
  const commonPeriods = [...eligiblePeriods[0]!].filter(period => eligiblePeriods.every(periods => periods.has(period)));
  if (commonPeriods.length === 0) {
    throw new ComparisonNormalizationError('NO_COMMON_COMPARABLE_PERIOD', 'Subjects have no common eligible single-quarter period');
  }
  commonPeriods.sort((left, right) => periodOrdinal(right) - periodOrdinal(left));
  const selectedPeriod = commonPeriods[0]!;

  const subjects: ComparisonSubject[] = acceptedSubjects.map(({ ticker, report }) => ({
    ticker,
    ...(typeof report.name === 'string' && report.name.trim() ? { name: report.name } : {}),
    ...(typeof report.sector === 'string' && report.sector.trim() ? { sector: report.sector } : {}),
  }));
  const warnings: ComparisonWarning[] = [];
  for (const subject of subjects) {
    if (!subject.sector) warnings.push({ code: 'MISSING_SECTOR', ticker: subject.ticker });
  }
  const sectorSubjects = subjects.filter(subject => subject.sector);
  if (new Set(sectorSubjects.map(subject => subject.sector)).size > 1) {
    warnings.push({ code: 'MIXED_SECTORS', tickers: sectorSubjects.map(subject => subject.ticker) });
  }

  for (const [index, accepted] of acceptedSubjects.entries()) {
    const eligible = [...eligiblePeriods[index]!].sort((left, right) => periodOrdinal(right) - periodOrdinal(left));
    const latest = eligible[0];
    if (latest && periodOrdinal(selectedPeriod) < periodOrdinal(latest)) {
      warnings.push({ code: 'SELECTED_PERIOD_OLDER_THAN_LATEST', ticker: accepted.ticker, selectedPeriod, latestAvailablePeriod: latest });
    }
  }

  for (const metric of METRICS) {
    for (const [index, accepted] of acceptedSubjects.entries()) {
      const quarterIndex = quarterIndexes[index]!.get(selectedPeriod)!;
      const quarter = accepted.quarterly.quarters[quarterIndex]!;
      const basis = quarter.growthBasis?.[metric];
      if (basis?.status === 'unproven') warnings.push({ code: 'BASIS_UNPROVEN', ticker: accepted.ticker, metric });
      else if (!basis) warnings.push({ code: 'BASIS_MISSING', ticker: accepted.ticker, metric });
    }
  }
  warnings.push(...buildFreshnessWarnings(acceptedSubjects));

  const metrics: ComparisonMetric[] = METRICS.map((metric) => {
    const cells: ComparisonCell[] = acceptedSubjects.map((accepted, index) => {
      const quarterIndex = quarterIndexes[index]!.get(selectedPeriod)!;
      const quarter = accepted.quarterly.quarters[quarterIndex]!;
      const value = quarter[metric];
      const basis = quarter.growthBasis?.[metric];
      const path = `quarters[${quarterIndex}].${metric}`;
      const source = sourceReference(accepted.quarterlyEvidenceId, path, selectedPeriod);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ticker: accepted.ticker, status: 'unavailable', reason: 'VALUE_MISSING', unit: 'percent', source };
      }
      if (basis?.status === 'unproven') {
        return { ticker: accepted.ticker, status: 'unavailable', reason: 'BASIS_UNPROVEN', unit: 'percent', source };
      }
      if (!basis) {
        return { ticker: accepted.ticker, status: 'unavailable', reason: 'BASIS_MISSING', unit: 'percent', source };
      }
      if (basis.period !== selectedPeriod || basis.periodType !== 'single_quarter' || basis.unit !== 'percent') {
        throw new ComparisonNormalizationError('INVALID_EVIDENCE', `Growth proof for ${accepted.ticker} does not match ${selectedPeriod}`);
      }
      return { ticker: accepted.ticker, status: 'available', value, unit: 'percent', source };
    });
    const comparable = cells.every(cell => cell.status === 'available');
    return { metric, unit: 'percent', status: comparable ? 'comparable' : 'unavailable', cells };
  });

  if (!metrics.some(metric => metric.status === 'comparable')) {
    throw new ComparisonNormalizationError('NO_COMPARABLE_METRICS', 'No fixed growth metric is proven for every subject');
  }

  const differences: ComparisonDifference[] = [];
  for (const metric of metrics) {
    if (metric.status !== 'comparable') continue;
    for (let leftIndex = 0; leftIndex < metric.cells.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < metric.cells.length; rightIndex += 1) {
        const left = metric.cells[leftIndex]!;
        const right = metric.cells[rightIndex]!;
        if (left.status !== 'available' || right.status !== 'available') continue;
        const value = left.value - right.value;
        if (!Number.isFinite(value)) throw new ComparisonNormalizationError('INVALID_EVIDENCE', 'Pairwise growth difference is not finite');
        differences.push({
          metric: metric.metric,
          leftTicker: left.ticker,
          rightTicker: right.ticker,
          value,
          unit: 'percentage_points',
          left: left.source,
          right: right.source,
        });
      }
    }
  }

  return ComparisonMatrixSchema.parse({ subjects, selectedPeriod, metrics, differences, warnings });
}
