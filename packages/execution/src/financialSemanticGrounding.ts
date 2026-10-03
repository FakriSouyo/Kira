import { EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID } from '@harness/evidence';
import type { Evidence } from '@harness/schemas';
import { matchesGroundedNumber, numericAssertionDetails, numericValueAtPath } from './numericGrounding';

export type FinancialObservationKind = 'company_report' | 'quarterly_financials';
export type FinancialUnitClass = 'percent' | 'ratio' | 'multiple' | 'nominal' | 'currency';

export interface FinancialSemanticFigure {
  metric: string;
  unitClass: FinancialUnitClass;
  value: number;
  periodLabel: string;
  currencyCode?: string;
}

export type FinancialEvidenceClassification =
  | { scope: 'legacy' }
  | { scope: 'supported'; kind: FinancialObservationKind }
  | { scope: 'outside' }
  | { scope: 'invalid' };

const CURRENT_FINANCIAL_OBSERVATION_KINDS = new Set([
  'company_report', 'quarterly_financials', 'daily_transaction', 'foreign_flow', 'news', 'filings', 'sentiment',
]);

export function classifyFinancialEvidence(evidence: Evidence): FinancialEvidenceClassification {
  const acceptance = evidence.acceptance;
  if (!acceptance || acceptance.candidateKind === 'legacy' || acceptance.candidateKind === 'document') return { scope: 'legacy' };
  if (acceptance.candidateKind !== 'financial') return { scope: 'invalid' };
  if (acceptance.policyId !== EVIDENCE_POLICY_ID || acceptance.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT) {
    return { scope: 'invalid' };
  }
  const main = asRecord(evidence.provenance);
  const accepted = asRecord(acceptance.provenance);
  const mainKind = main?.observationKind;
  const acceptedKind = accepted?.observationKind;
  if (mainKind !== acceptedKind || typeof mainKind !== 'string' || !CURRENT_FINANCIAL_OBSERVATION_KINDS.has(mainKind)) return { scope: 'invalid' };
  if (mainKind === 'company_report' || mainKind === 'quarterly_financials') return { scope: 'supported', kind: mainKind };
  return { scope: 'outside' };
}

interface MetricDefinition {
  metric: string;
  unitClass: FinancialUnitClass;
}

const COMPANY_REPORT_PATHS: Readonly<Record<string, MetricDefinition>> = {
  'financials.roe': { metric: 'roe', unitClass: 'percent' },
  'financials.roa': { metric: 'roa', unitClass: 'percent' },
  'financials.netMargin': { metric: 'netMargin', unitClass: 'percent' },
  'financials.grossMargin': { metric: 'grossMargin', unitClass: 'percent' },
  'financials.debtToEquity': { metric: 'debtToEquity', unitClass: 'ratio' },
  'financials.currentRatio': { metric: 'currentRatio', unitClass: 'ratio' },
  'financials.yoyQuarterRevenueGrowth': { metric: 'revenueGrowthYoy', unitClass: 'percent' },
  'financials.yoyQuarterEarningsGrowth': { metric: 'netIncomeGrowthYoy', unitClass: 'percent' },
  'valuation.price': { metric: 'price', unitClass: 'nominal' },
  'valuation.pe': { metric: 'pe', unitClass: 'multiple' },
  'valuation.pb': { metric: 'pb', unitClass: 'multiple' },
  'valuation.dividendYield': { metric: 'dividendYield', unitClass: 'percent' },
};

const QUARTERLY_FIELDS: Readonly<Record<string, MetricDefinition>> = {
  revenue: { metric: 'revenue', unitClass: 'currency' },
  netIncome: { metric: 'netIncome', unitClass: 'currency' },
  revenueGrowthYoy: { metric: 'revenueGrowthYoy', unitClass: 'percent' },
  netIncomeGrowthYoy: { metric: 'netIncomeGrowthYoy', unitClass: 'percent' },
};

const FINANCIAL_TERMS: Array<[string, RegExp]> = [
  ['revenueGrowthYoy', /\b(?:revenue|sales)\s+growth\b|\b(?:yoy|year[-\s]+over[-\s]+year)\s+(?:revenue|sales)\s+growth\b/i],
  ['netIncomeGrowthYoy', /\b(?:net\s+income|earnings)\s+growth\b|\b(?:yoy|year[-\s]+over[-\s]+year)\s+(?:net\s+income|earnings)\s+growth\b/i],
  ['debtToEquity', /\bdebt(?:\s*[- ]\s*to\s*[- ]\s*|\s+)equity(?:\s+ratio)?\b/i],
  ['currentRatio', /\bcurrent\s+ratio\b/i],
  ['grossMargin', /\bgross\s+margin\b/i],
  ['netMargin', /\bnet\s+margin\b/i],
  ['dividendYield', /\bdividend\s+yield\b/i],
  ['revenue', /\b(?:revenue|sales)\b/i],
  ['netIncome', /\b(?:net\s+income|earnings)\b/i],
  ['roe', /\b(?:roe|return\s+on\s+equity)\b/i],
  ['roa', /\b(?:roa|return\s+on\s+assets)\b/i],
  ['pe', /\b(?:p\s*\/\s*e|price\s*[- ]\s*to\s*[- ]\s*earnings)\b/i],
  ['pb', /\b(?:p\s*\/\s*b|price\s*[- ]\s*to\s*[- ]\s*book)\b/i],
  ['price', /\b(?:share\s+)?price\b/i],
];

const CURRENCY_CODES = new Set([
  'AED', 'ARS', 'AUD', 'BDT', 'BHD', 'BND', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK',
  'EGP', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KES', 'KRW', 'KWD', 'LKR', 'MAD',
  'MUR', 'MXN', 'MYR', 'NGN', 'NOK', 'NPR', 'NZD', 'OMR', 'PEN', 'PHP', 'PKR', 'PLN', 'QAR', 'RON',
  'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'VND', 'ZAR',
]);
const CURRENCY_CODE_PATTERN = new RegExp(`\\b(?:${[...CURRENCY_CODES].join('|')})\\b`);
const DIRECT_QUANTITY_GAP = new RegExp(
  `^\\s+(?:(?:was|is|reached|at|of|increased|grew|rose|fell|declined|decreased)\\s+)?(?:${CURRENCY_CODE_PATTERN.source}\\s+)?$`,
  'i',
);

export function resolveFinancialPathMeaning(
  kind: FinancialObservationKind,
  path: string,
  data: unknown,
): Pick<FinancialSemanticFigure, 'metric' | 'unitClass' | 'currencyCode'> | undefined {
  let definition: MetricDefinition | undefined;
  if (kind === 'company_report') {
    definition = COMPANY_REPORT_PATHS[path];
  } else {
    const quarter = /^quarters(?:\[(\d+)\]|\.(\d+))\.(revenue|netIncome|revenueGrowthYoy|netIncomeGrowthYoy)$/.exec(path);
    const ytd = /^cumulativeYtd\.(revenueGrowthYoy|netIncomeGrowthYoy)$/.exec(path);
    if (quarter) definition = QUARTERLY_FIELDS[quarter[3]!];
    else if (ytd) definition = QUARTERLY_FIELDS[ytd[1]!];
  }
  if (!definition) return undefined;
  const currency = definition.unitClass === 'currency' && isRecord(data) ? data.currency : undefined;
  const currencyCode = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : undefined;
  return {
    metric: definition.metric,
    unitClass: definition.unitClass === 'currency' && !currencyCode ? 'nominal' : definition.unitClass,
    ...(definition.unitClass === 'currency' && currencyCode ? { currencyCode } : {}),
  };
}

export function resolveFinancialSemanticFigure(params: {
  kind: FinancialObservationKind;
  path: string;
  data: unknown;
  periodLabel: string;
}): FinancialSemanticFigure | undefined {
  const meaning = resolveFinancialPathMeaning(params.kind, params.path, params.data);
  const value = numericValueAtPath(params.data, params.path);
  if (!meaning || typeof value !== 'number' || !Number.isFinite(value) || !params.periodLabel.trim()) return undefined;
  return { ...meaning, value, periodLabel: params.periodLabel };
}

export interface FinancialNumericAssertion {
  value: number;
  start: number;
  end: number;
  metric?: string;
  unit?: 'percent' | 'multiple' | 'bps';
  currencyCode?: string;
  currencySymbol?: string;
  magnitudeModifier?: string;
}

const NUMBER_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)';
const NUMBER_WORD_SEQUENCE = new RegExp(`\\b${NUMBER_WORD}(?:[ -]+${NUMBER_WORD})*(?:\\s+point(?:\\s+${NUMBER_WORD})+)?\\b`, 'gi');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function clauseBounds(text: string, start: number, end: number): [number, number] {
  let clauseStart = 0;
  let clauseEnd = text.length;
  const boundary = /[!?;,]|\.(?=\s|$)|\b(?:while|whereas)\b/gi;
  for (const match of text.matchAll(boundary)) {
    const after = match.index! + match[0]!.length;
    if (after <= start) clauseStart = after;
    else if (match.index! >= end) {
      clauseEnd = match.index!;
      break;
    }
  }
  return [clauseStart, clauseEnd];
}

function metricNear(text: string, start: number, end: number): string | undefined {
  const [clauseStart, clauseEnd] = clauseBounds(text, start, end);
  const clause = text.slice(clauseStart, clauseEnd);
  const matches: Array<{ metric: string; distance: number }> = [];
  for (const [metric, pattern] of FINANCIAL_TERMS) {
    const expression = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of clause.matchAll(expression)) {
      const left = clauseStart + match.index!;
      const right = left + match[0]!.length;
      matches.push({ metric, distance: start < left ? left - start : start > right ? start - right : 0 });
    }
  }
  if (matches.length === 0) return undefined;
  const distance = Math.min(...matches.map(match => match.distance));
  const metrics = new Set(matches.filter(match => match.distance === distance).map(match => match.metric));
  return metrics.size === 1 ? [...metrics][0] : undefined;
}

export function financialNumericAssertions(statement: string): FinancialNumericAssertion[] {
  const periods = [...statement.matchAll(/\b(?:19|20)\d{2}-Q[1-4]\b|\b\d{4}-\d{2}-\d{2}\b|\bQ[1-4]\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s+Q[1-4]\b|\b[HF]?[12]\s+(?:19|20)\d{2}\b|\bFY\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s+FY\b/gi)]
    .map(match => [match.index!, match.index! + match[0]!.length] as const);
  const assertions: FinancialNumericAssertion[] = [];
  const pattern = /(?<![\w.])(-?\d[\d,]*(?:\.\d+)?)(?:\s*(%|x|times?|bps))?(?![\w])/gi;
  for (const match of statement.matchAll(pattern)) {
    const start = match.index!;
    const end = start + match[0]!.length;
    if (periods.some(([left, right]) => start < right && end > left)) continue;
    const value = Number(match[1]!.replaceAll(',', ''));
    if (!Number.isFinite(value)) continue;
    const before = statement.slice(Math.max(0, start - 48), start);
    const after = statement.slice(end, Math.min(statement.length, end + 20));
    const currencyPrefix = /\b([A-Z]{3})\s*$/.exec(before)?.[1];
    const currencySuffix = /^\s*([A-Z]{3})\b/.exec(after)?.[1];
    const currencyCode = currencyPrefix && CURRENCY_CODES.has(currencyPrefix) ? currencyPrefix
      : currencySuffix && CURRENCY_CODES.has(currencySuffix) ? currencySuffix : undefined;
    const currencySymbol = /([$€£¥₹₩₽])\s*$/.exec(before)?.[1];
    const marker = match[2]?.toLowerCase();
    const magnitudeModifier = /^\s*(thousand|million|billion|trillion)s?\b/i.exec(after)?.[1]?.toLowerCase();
    const metric = metricNear(statement, start, end);
    if (!marker && !currencyCode && !currencySymbol && !metric) continue;
    assertions.push({
      value, start, end,
      ...(metric ? { metric } : {}),
      ...(marker === '%' ? { unit: 'percent' as const }
        : marker === 'x' || marker?.startsWith('time') ? { unit: 'multiple' as const }
          : marker ? { unit: 'bps' as const } : {}),
      ...(currencyCode ? { currencyCode } : {}),
      ...(currencySymbol ? { currencySymbol } : {}),
      ...(magnitudeModifier ? { magnitudeModifier } : {}),
    });
  }
  return assertions;
}

export function financialAssertionMatches(params: {
  assertion: FinancialNumericAssertion;
  figure: FinancialSemanticFigure;
  statedMetric?: string;
}): boolean {
  const { assertion, figure } = params;
  const metric = params.statedMetric ?? assertion.metric;
  if (!metric || metric !== figure.metric || assertion.magnitudeModifier || !matchesGroundedNumber(assertion.value, figure.value)) return false;
  if (assertion.currencySymbol) return false;
  if (figure.unitClass === 'percent' && assertion.unit !== 'percent') return false;
  if (figure.unitClass === 'multiple' && assertion.unit !== 'multiple') return false;
  if (figure.unitClass === 'currency' && (!figure.currencyCode || assertion.currencyCode !== figure.currencyCode)) return false;
  if (assertion.unit === 'percent' && figure.unitClass !== 'percent') return false;
  if (assertion.unit === 'multiple' && figure.unitClass !== 'multiple') return false;
  if (assertion.unit === 'bps') return false;
  if (assertion.currencyCode && (figure.unitClass !== 'currency' || figure.currencyCode !== assertion.currencyCode)) return false;
  return true;
}

export function financialStatementIsGrounded(statement: string, figures: readonly FinancialSemanticFigure[]): boolean {
  if (hasUnsupportedQuantitativeWords(statement)) return false;
  return financialNumericAssertions(statement).every(assertion =>
    figures.some(figure => financialAssertionMatches({ assertion, figure })));
}

export function financialStatementIsGroundedWithCompatibility(params: {
  statement: string;
  actualSemanticFigures: readonly FinancialSemanticFigure[];
  citedSemanticFigures: readonly FinancialSemanticFigure[];
  compatibilityFigures: readonly { actual: number; cited: number }[];
}): boolean {
  const { statement, actualSemanticFigures, citedSemanticFigures, compatibilityFigures } = params;
  if (hasUnsupportedQuantitativeWords(statement)) return false;
  const semanticAssertions = financialNumericAssertions(statement).filter(assertion => assertion.metric !== undefined);
  if (!semanticAssertions.every(assertion =>
    actualSemanticFigures.some(figure => financialAssertionMatches({ assertion, figure }))
      && citedSemanticFigures.some(figure => financialAssertionMatches({ assertion, figure })))) return false;
  return numericAssertionDetails(statement).every(assertion =>
    semanticAssertions.some(semantic => assertion.start === semantic.start)
      || compatibilityFigures.some(figure =>
        matchesGroundedNumber(assertion.value, figure.cited) && matchesGroundedNumber(assertion.value, figure.actual)));
}

function hasUnsupportedQuantitativeWords(statement: string): boolean {
  for (const match of statement.matchAll(NUMBER_WORD_SEQUENCE)) {
    const start = match.index!;
    const end = start + match[0]!.length;
    if (/^one$/i.test(match[0]!) && /^\s+of\b/i.test(statement.slice(end))) continue;
    if (/^\s+(?:of|audited\s+sources?|sources?|metrics?|indicators?|periods?|quarters?|years?)\b/i.test(statement.slice(end))) continue;
    const before = statement.slice(Math.max(0, start - 64), start);
    for (const [, pattern] of FINANCIAL_TERMS) {
      const expression = new RegExp(pattern.source, `${pattern.flags}g`);
      for (const metric of before.matchAll(expression)) {
        const metricEnd = metric.index! + metric[0]!.length;
        const gap = before.slice(metricEnd);
        if (DIRECT_QUANTITY_GAP.test(gap)) return true;
      }
    }
  }
  return false;
}
