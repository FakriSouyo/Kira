import type { EvidenceStore } from '@harness/evidence';
import { canonicalHash, EVIDENCE_POLICY_FINGERPRINT, EVIDENCE_POLICY_ID } from '@harness/evidence';
import { verifyFinancialObservation, type FinancialDataMetadata, type FinancialObservationKind } from '@harness/financial-data';
import { financialAssertionMatches, numericValueAtPath, resolveFinancialPathMeaning } from '@harness/execution';
import { canonicalJson, hasTransactionDirective } from '@harness/shared';
import type { Evidence } from '@harness/schemas';
import { ChallengeReportPayloadSchema, type ChallengeCitedFigure, type ChallengeMetric, type ChallengeReportPayload } from '@harness/schemas';
import { ChallengeAnalystOutputSchema, type ChallengeAnalystOutput } from '@harness/subagent-challenger';

export type ChallengeGroundingErrorCode = 'INVALID_INPUT' | 'INVALID_EVIDENCE' | 'INVALID_OUTPUT' | 'VALIDATION_UNAVAILABLE' | 'CANCELLED';

export class ChallengeGroundingError extends Error {
  constructor(readonly code: ChallengeGroundingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ChallengeGroundingError';
  }
}

type FinancialKind = 'company_report' | 'quarterly_financials';

interface GroundedEvidence {
  evidence: Evidence;
  kind: FinancialKind;
  metadata: FinancialDataMetadata;
}

const CURRENCY_CODES = new Set([
  'AED', 'ARS', 'AUD', 'BDT', 'BHD', 'BND', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK',
  'EGP', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KES', 'KRW', 'KWD', 'LKR',
  'MAD', 'MUR', 'MXN', 'MYR', 'NGN', 'NOK', 'NPR', 'NZD', 'OMR', 'PEN', 'PHP', 'PKR', 'PLN',
  'QAR', 'RON', 'SAR', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'VND', 'ZAR',
]);

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000, trillion: 1_000_000_000_000 };
const FINANCIAL_TERMS = /\b(?:roe|roa|net\s+margin|gross\s+margin|margin|debt(?:-to)?\s+equity|current\s+ratio|ratio|revenue|sales|net\s+income|earnings|growth|yield|price|p\s*\/\s*e|p\s*\/\s*b|valuation|profitability|profit)\b/i;
const UNAVAILABLE_FINANCIAL_VERDICTS = /\b(?:verdict|stance|bullish|bearish|rank(?:ed|ing)?|winner|winning|outperform(?:ed|s|ing)?|dominant|leader|best[- ]performing|score|recommend(?:ation|ed|s)?|target[ -]+price|trade[ -]+instructions?)\b/i;
const RECOMMENDATION_CONTEXT = /\b(?:(?:recommend(?:s|ed|ation)?|should|must|would|could|can|consider|suggest(?:s|ed)?)\s+(?:to\s+)?(?:buy(?:ing)?|sell(?:ing)?|hold(?:ing)?)|(?:buy|sell|hold)\s+(?:(?:the|this|a|an)\s+)?(?:shares?|stock|position))\b/i;
const DIRECT_TICKER_RECOMMENDATION = /\b(?:buy|sell|hold)\s+[A-Z]{4,6}\b/i;
const STANDALONE_TRADE_INSTRUCTION = /^\s*(?:buy|sell|hold)(?:\s+(?:now|it))?[.!?]*\s*$/i;
const COMPARATIVE_STATE = /\b(?:(?:is|are|was|were|remain(?:s|ed)?|stay(?:s|ed)?|rank(?:ed)?|finish(?:es|ed)?|place[sd])\s+(?:roughly|much|far|substantially)?\s*(?:higher|lower|ahead|behind|stronger|weaker|better|worse|superior|inferior|dominant|highest|lowest)|(?:higher|lower|stronger|weaker|better|worse|superior|inferior|highest|lowest)\s+(?:than|to|versus|vs\.?|compared\s+(?:with|to)|relative\s+to)\b|(?:ahead|behind)\s+of\b|(?:above|below)\s+(?:(?:the|a|an)\s+)?(?:peer(?:s)?|industry\s+norm|cohort|baseline|market|sector|consensus|index|benchmark)\b|(?:rose|rise|rises|grew|grow|grows|increased|increases|improved|improves)\s+(?:much\s+)?(?:faster|slower|higher|lower|more|less)\b)/i;
const COMPARATIVE_ACTION = /\b(?:outperform(?:ed|s|ing)?|underperform(?:ed|s|ing)?|lead(?:s|ing)?|led|beat(?:s|ing)?|exceed(?:ed|s|ing)?)\b(?!\s+to\b)/i;
const CHANGE_VERBS = 'rise|rises|rising|rose|risen|grow|grows|growing|grew|grown|increase|increases|increasing|increased|climb|climbs|climbing|climbed|improve|improves|improving|improved|fall|falls|falling|fell|fallen|drop|drops|dropping|dropped|decline|declines|declining|declined|decrease|decreases|decreasing|decreased|slide|slides|sliding|slid|expand|expands|expanding|expanded|contract|contracts|contracting|contracted|widen|widens|widening|widened|narrow|narrows|narrowing|narrowed|weaken|weakens|weakening|weakened|strengthen|strengthens|strengthening|strengthened|cool|cools|cooling|cooled|slow|slows|slowing|slowed|worsen|worsens|worsening|worsened|accelerate|accelerates|accelerating|accelerated';
const CHANGE_ASSERTION = new RegExp(`\\b(?:${CHANGE_VERBS})\\b`, 'i');
const POSITIVE_CHANGE_VERBS = new Set(['rise', 'rises', 'rising', 'rose', 'risen', 'grow', 'grows', 'growing', 'grew', 'grown', 'increase', 'increases', 'increasing', 'increased', 'climb', 'climbs', 'climbing', 'climbed', 'improve', 'improves', 'improving', 'improved', 'expand', 'expands', 'expanding', 'expanded', 'widen', 'widens', 'widening', 'widened', 'strengthen', 'strengthens', 'strengthening', 'strengthened', 'accelerate', 'accelerates', 'accelerating', 'accelerated']);
const NEGATIVE_CHANGE_VERBS = new Set(['fall', 'falls', 'falling', 'fell', 'fallen', 'drop', 'drops', 'dropping', 'dropped', 'decline', 'declines', 'declining', 'declined', 'decrease', 'decreases', 'decreasing', 'decreased', 'slide', 'slides', 'sliding', 'slid', 'contract', 'contracts', 'contracting', 'contracted', 'narrow', 'narrows', 'narrowing', 'narrowed', 'weaken', 'weakens', 'weakening', 'weakened', 'cool', 'cools', 'cooling', 'cooled', 'slow', 'slows', 'slowing', 'slowed', 'worsen', 'worsens', 'worsening', 'worsened']);
const REPORTED_YOY_CHANGE_VERBS = new Set(['rise', 'rises', 'rising', 'rose', 'risen', 'grow', 'grows', 'growing', 'grew', 'grown', 'increase', 'increases', 'increasing', 'increased', 'climb', 'climbs', 'climbing', 'climbed', 'improve', 'improves', 'improving', 'improved', 'fall', 'falls', 'falling', 'fell', 'fallen', 'drop', 'drops', 'dropping', 'dropped', 'decline', 'declines', 'declining', 'declined', 'decrease', 'decreases', 'decreasing', 'decreased', 'slide', 'slides', 'sliding', 'slid']);
const IMPLICIT_BOUND = /\b(?:or\s+less|or\s+more|at\s+most|at\s+least|no\s+more\s+than|no\s+less\s+than|up\s+to|below|above|under|over|greater\s+than|less\s+than)\b/i;
const METRIC_PATTERNS: Array<[ChallengeMetric, RegExp]> = [
  ['revenueGrowthYoy', /\b(?:revenue|sales|net\s+sales|top[-\s]?line)\s+growth\b/i],
  ['netIncomeGrowthYoy', /\b(?:net\s+income|earnings)\s+growth\b/i],
  ['debtToEquity', /\bdebt(?:[-\s]?to[-\s]?)?equity(?:\s+ratio)?\b/i],
  ['currentRatio', /\bcurrent\s+ratio\b/i],
  ['dividendYield', /\bdividend\s+yield\b/i],
  ['netMargin', /\bnet\s+margin\b/i],
  ['grossMargin', /\bgross\s+margin\b/i],
  ['roe', /\b(?:roe|return\s+on\s+equity)\b/i],
  ['roa', /\b(?:roa|return\s+on\s+assets)\b/i],
  ['pe', /\b(?:p\s*\/\s*e|pe\s+ratio|price[-\s]+to[-\s]+earnings)\b/i],
  ['pb', /\b(?:p\s*\/\s*b|pb\s+ratio|price[-\s]+to[-\s]+book)\b/i],
  ['revenue', /\b(?:revenue|sales|net\s+sales)\b(?!\s+growth)/i],
  ['netIncome', /\b(?:net\s+income|earnings)\b(?!\s+growth)/i],
  ['price', /\bprice\b(?![-\s]+to[-\s]+(?:earnings|book))/i],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidEvidence(message: string): never {
  throw new ChallengeGroundingError('INVALID_EVIDENCE', message);
}

function invalidOutput(message: string): never {
  throw new ChallengeGroundingError('INVALID_OUTPUT', message);
}

function hasUnavailableVerdict(text: string): boolean {
  return UNAVAILABLE_FINANCIAL_VERDICTS.test(text)
    || RECOMMENDATION_CONTEXT.test(text)
    || DIRECT_TICKER_RECOMMENDATION.test(text)
    || STANDALONE_TRADE_INSTRUCTION.test(text)
    || hasTransactionDirective(text);
}

function changeDirection(verb: string): 1 | -1 | undefined {
  const normalized = verb.toLowerCase();
  if (POSITIVE_CHANGE_VERBS.has(normalized)) return 1;
  if (NEGATIVE_CHANGE_VERBS.has(normalized)) return -1;
  return undefined;
}

function relationClauses(text: string): string[] {
  const sentences = text.split(/[!?;]|\.(?=\s|$)/);
  return sentences.flatMap(sentence => {
    const temporalPrefix = /^\s*(?:as|when|once)\b[^,]*,/i.exec(sentence)?.[0];
    if (temporalPrefix) {
      return sentence.slice(temporalPrefix.length)
        .split(/,|\b(?:yet|though|although|but)\b/i)
        .map((clause, index) => index === 0 ? `${temporalPrefix}${clause}` : clause);
    }
    return sentence.split(/,|\b(?:yet|though|although|but)\b/i);
  }).map(clause => clause.trim()).filter(Boolean);
}

function isProspectiveChangeClause(clause: string, changeStart: number): boolean {
  const prefix = clause.slice(0, changeStart);
  const modal = /\b(may|might|could|will|would)\b(?:\s+\w+){0,2}\s*$/i.exec(prefix);
  if (!modal) return false;
  const modalWords = modal[0]!.trim().toLowerCase().split(/\s+/);
  if (modalWords.includes('have')) return false;
  if (modalWords[0] === 'would') return true;

  const immediatePrefix = clause.slice(Math.max(0, modal.index! - 64), modal.index!);
  if (/\b(?:future|later|next|subsequent|another|upcoming)\b/i.test(immediatePrefix)) return true;

  const temporal = /^\s*(as|when|once)\b([^,]*),/i.exec(clause);
  if (!temporal || changeStart < temporal[0]!.length) return false;
  const temporalWords = temporal[2]!.toLowerCase();
  if (/\b(?:was|were|had|did|accumulated|arrived|became)\b/.test(temporalWords)) return false;
  return /\b(?:later|next|subsequent|another|future|upcoming)\b/.test(temporalWords)
    || (temporal[1]!.toLowerCase() === 'once' && /\b(?:complete|finished|over)\b/.test(temporalWords));
}

function assertNoUnsupportedRelations(text: string, deferGroundedChanges = false): void {
  for (const clause of relationClauses(text)) {
    if (COMPARATIVE_STATE.test(clause) || COMPARATIVE_ACTION.test(clause)) {
      invalidOutput('Comparative claims require a supported comparison contract');
    }
    const hasNumericAssertion = numericAssertions(clause).length > 0;
    const changes = new RegExp(CHANGE_ASSERTION.source, `${CHANGE_ASSERTION.flags}g`);
    for (const changeMatch of clause.matchAll(changes)) {
      if (deferGroundedChanges && hasNumericAssertion) continue;
      if (!isProspectiveChangeClause(clause, changeMatch.index!)) {
        invalidOutput('Directional change claims require grounded Evidence or a prospective condition');
      }
    }
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ChallengeGroundingError('CANCELLED', 'Challenge grounding was cancelled');
}

function provenanceRecord(evidence: Evidence, name: 'provenance' | 'acceptance'): Record<string, unknown> {
  const value = name === 'provenance' ? evidence.provenance : evidence.acceptance?.provenance;
  if (!isRecord(value)) invalidEvidence(`Evidence ${evidence.id} has no ${name} record`);
  return value;
}

function metadataOf(evidence: Evidence): FinancialDataMetadata {
  const main = provenanceRecord(evidence, 'provenance');
  const accepted = provenanceRecord(evidence, 'acceptance');
  const mainMetadata = main.metadata;
  const acceptedMetadata = accepted.metadata;
  if (!isRecord(mainMetadata) || !isRecord(acceptedMetadata)) invalidEvidence(`Evidence ${evidence.id} has incomplete financial metadata`);
  if (canonicalJson(mainMetadata) !== canonicalJson(acceptedMetadata)) {
    invalidEvidence(`Evidence ${evidence.id} has conflicting accepted financial metadata`);
  }
  return mainMetadata as unknown as FinancialDataMetadata;
}

function observationKindOf(evidence: Evidence): FinancialKind {
  const main = provenanceRecord(evidence, 'provenance');
  const accepted = provenanceRecord(evidence, 'acceptance');
  const kinds = [main.observationKind, accepted.observationKind];
  if (kinds[0] !== kinds[1] || (kinds[0] !== 'company_report' && kinds[0] !== 'quarterly_financials')) {
    invalidEvidence(`Evidence ${evidence.id} has an unsupported or conflicting financial observation kind`);
  }
  return kinds[0];
}

function verificationOf(evidence: Evidence, kind: FinancialKind, metadata: FinancialDataMetadata): void {
  const main = provenanceRecord(evidence, 'provenance');
  const accepted = provenanceRecord(evidence, 'acceptance');
  if (!isRecord(main.verification) || !isRecord(accepted.verification)
    || canonicalJson(main.verification) !== canonicalJson(accepted.verification)) {
    invalidEvidence(`Evidence ${evidence.id} has conflicting financial verification`);
  }
  let verified: ReturnType<typeof verifyFinancialObservation>;
  try {
    verified = verifyFinancialObservation(kind as FinancialObservationKind, { data: evidence.data as never, metadata }, evidence.ticker);
  } catch (cause) {
    throw new ChallengeGroundingError('INVALID_EVIDENCE', `Evidence ${evidence.id} failed current financial verification`, { cause });
  }
  if (canonicalJson(verified.verification) !== canonicalJson(main.verification)) {
    invalidEvidence(`Evidence ${evidence.id} verification does not match the current financial verifier`);
  }
}

function validateAcceptedEvidence(evidence: Evidence, executionId: string, ticker: string): GroundedEvidence {
  if (evidence.runId !== executionId) invalidEvidence(`Evidence ${evidence.id} is outside Execution ${executionId}`);
  if (evidence.ticker !== ticker) invalidEvidence(`Evidence ${evidence.id} belongs to another ticker`);
  const acceptance = evidence.acceptance;
  if (!acceptance || acceptance.legacy === true || acceptance.candidateKind !== 'financial'
    || acceptance.policyId !== EVIDENCE_POLICY_ID || acceptance.policyFingerprint !== EVIDENCE_POLICY_FINGERPRINT) {
    invalidEvidence(`Evidence ${evidence.id} lacks current financial Evidence acceptance`);
  }
  if (typeof acceptance.acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptance.acceptedAt))
    || acceptance.validAt !== null || (evidence.validAt !== undefined && evidence.validAt !== null)) {
    invalidEvidence(`Evidence ${evidence.id} has incomplete current acceptance timestamps`);
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.contentHash) || canonicalHash(evidence.data) !== evidence.contentHash) {
    invalidEvidence(`Evidence ${evidence.id} content hash does not match its data`);
  }
  const kind = observationKindOf(evidence);
  const metadata = metadataOf(evidence);
  const expectedSourceType = metadata.origin === 'CACHE' ? 'cached'
    : metadata.origin === 'MOCK' ? 'mock'
      : metadata.origin === 'DERIVED' ? 'derived' : 'api';
  if (metadata.source !== evidence.source || acceptance.sourceOrigin !== metadata.origin
    || acceptance.retrievedAt !== metadata.fetchedAt
    || (metadata.fetchedAt !== null && evidence.retrievedAt !== metadata.fetchedAt)
    || evidence.sourceType !== expectedSourceType
    || acceptance.validAt !== (evidence.validAt ?? null)) {
    invalidEvidence(`Evidence ${evidence.id} accepted provenance does not match its record`);
  }
  if (canonicalJson(evidence.provenance) !== canonicalJson(acceptance.provenance)) {
    invalidEvidence(`Evidence ${evidence.id} has conflicting provenance copies`);
  }
  verificationOf(evidence, kind, metadata);
  return { evidence, kind, metadata };
}

function parseFinancialPath(path: string, item: GroundedEvidence): Pick<ChallengeCitedFigure, 'metric' | 'unitClass' | 'value' | 'periodLabel' | 'currencyCode'> {
  const { evidence, kind } = item;
  const meaning = resolveFinancialPathMeaning(kind, path, evidence.data);
  let periodLabel: string | undefined;

  if (kind === 'company_report') {
    const anchors = [item.metadata.dataAsOf, evidence.data.asOf].filter(value => value !== undefined && value !== null);
    if (anchors.length === 0 || anchors.some(value => typeof value !== 'string' || !value.trim()) || new Set(anchors).size !== 1) {
      invalidEvidence(`Company Report Evidence ${evidence.id} has no unambiguous reporting period`);
    }
    periodLabel = anchors[0] as string;
  } else {
    const quarterMatch = /^quarters(?:\[(\d+)\]|\.(\d+))\./.exec(path);
    const ytdMatch = /^cumulativeYtd\./.exec(path);
    if (quarterMatch) {
      const index = Number(quarterMatch[1] ?? quarterMatch[2]);
      const quarters = evidence.data.quarters;
      if (!Array.isArray(quarters)) {
        invalidEvidence(`Quarterly Financials Evidence ${evidence.id} has malformed quarters`);
      }
      if (index >= quarters.length) {
        invalidOutput(`Challenge cited unavailable Evidence path ${path}`);
      }
      if (!isRecord(quarters[index])) {
        invalidEvidence(`Quarterly Financials Evidence ${evidence.id} path ${path} is missing`);
      }
      const quarter = quarters[index] as Record<string, unknown>;
      periodLabel = typeof quarter.period === 'string' ? quarter.period : undefined;
    } else if (ytdMatch) {
      const ytd = evidence.data.cumulativeYtd;
      if (!isRecord(ytd)) invalidOutput(`Challenge cited unavailable Evidence path ${path}`);
      periodLabel = typeof ytd.periodLabel === 'string' ? ytd.periodLabel : undefined;
    }
  }

  if (!meaning) invalidOutput(`Challenge cited unsupported Evidence path ${path}`);
  const value = valueAtPath(item, path);
  if (!periodLabel || !periodLabel.trim()) invalidEvidence(`Evidence path ${path} has no verified reporting period`);
  return {
    metric: meaning.metric as ChallengeMetric,
    unitClass: meaning.unitClass,
    value,
    periodLabel,
    ...(meaning.currencyCode ? { currencyCode: meaning.currencyCode } : {}),
  };
}

interface NumberAssertion {
  value: number;
  start: number;
  end: number;
  unit?: 'percent' | 'multiple' | 'bps';
  currencyCode?: string;
  currencySymbol?: string;
}

const METRIC_VALUE_RELATIONS = new Set([
  'is', 'are', 'was', 'were', 'at', 'to', 'from', 'by', 'of', 'reached', 'rose', 'rise', 'grew', 'increased',
  'climbed', 'improved', 'fell', 'fall', 'dropped', 'declined', 'decreased', 'slid', 'stood', 'remained',
  'approximately', 'approx', 'roughly', 'about', 'around', 'nearly', 'over', 'under', 'above', 'below', 'less',
  'more', 'equal', 'equals', 'reported', 'recorded', 'measured', 'totaled', 'totalled',
]);

function isMetricValueBridge(bridge: string): boolean {
  const words = bridge.match(/[a-z]+/gi) ?? [];
  return words.every(word => METRIC_VALUE_RELATIONS.has(word.toLowerCase()))
    && /^[a-z\s,:;=#().—–-]*$/i.test(bridge);
}

function hasMetricValueFrame(text: string, start: number, end: number): boolean {
  let clauseStart = 0;
  let clauseEnd = text.length;
  const boundary = /[!?;]|\.(?=\s|$)/g;
  for (const match of text.matchAll(boundary)) {
    const afterBoundary = match.index! + match[0]!.length;
    if (afterBoundary <= start) clauseStart = afterBoundary;
    else if (match.index! >= end) {
      clauseEnd = match.index!;
      break;
    }
  }

  const clause = text.slice(clauseStart, clauseEnd);
  const localStart = start - clauseStart;
  const localEnd = end - clauseStart;
  const matcher = new RegExp(FINANCIAL_TERMS.source, `${FINANCIAL_TERMS.flags}g`);
  for (const match of clause.matchAll(matcher)) {
    const metricStart = match.index!;
    const metricEnd = metricStart + match[0]!.length;
    if (metricEnd <= localStart && isMetricValueBridge(clause.slice(metricEnd, localStart))) return true;
    if (metricStart >= localEnd && isMetricValueBridge(clause.slice(localEnd, metricStart))) return true;
  }

  const anaphor = /^\s*(?:this\s+figure|that\s+figure|the\s+figure|this\s+metric|that\s+metric|the\s+metric|it|this|that)\b/i.exec(clause);
  if (anaphor && isMetricValueBridge(clause.slice(anaphor[0]!.length, localStart))) {
    const previous = text.slice(0, clauseStart).trim().replace(/[!?;.]+$/, '').split(/[!?;]|\.(?=\s|$)/).at(-1) ?? '';
    if (FINANCIAL_TERMS.test(previous)) return true;
  }
  return false;
}

function parseIntegerWords(words: string[]): number | undefined {
  let total = 0;
  let group = 0;
  let saw = false;
  for (const word of words) {
    if (word === 'and') continue;
    if (Object.hasOwn(NUMBER_WORDS, word)) {
      group += NUMBER_WORDS[word]!;
      saw = true;
    } else if (Object.hasOwn(NUMBER_SCALES, word)) {
      const scale = NUMBER_SCALES[word]!;
      if (scale === 100) group = Math.max(group, 1) * 100;
      else {
        total += Math.max(group, 1) * scale;
        group = 0;
      }
      saw = true;
    } else return undefined;
  }
  return saw ? total + group : undefined;
}

function parseNumberWords(words: string[]): number | undefined {
  const pointIndex = words.indexOf('point');
  if (pointIndex < 0) return parseIntegerWords(words);
  if (words.indexOf('point', pointIndex + 1) >= 0) return undefined;
  const integer = pointIndex === 0 ? 0 : parseIntegerWords(words.slice(0, pointIndex));
  const decimalWords = words.slice(pointIndex + 1);
  if (integer === undefined || decimalWords.length === 0 || decimalWords.some(word => !Object.hasOwn(NUMBER_WORDS, word) || NUMBER_WORDS[word]! > 9)) return undefined;
  const decimal = decimalWords.map(word => NUMBER_WORDS[word]!.toString()).join('');
  return Number(`${integer}.${decimal}`);
}

function numberWordAssertions(text: string): NumberAssertion[] {
  const normalized = text.replace(/([a-z]+)-([a-z]+)/gi, '$1 $2');
  const tokens = [...normalized.matchAll(/[a-z]+/gi)].map(match => ({ word: match[0]!.toLowerCase(), start: match.index!, end: match.index! + match[0]!.length }));
  const output: NumberAssertion[] = [];
  const known = new Set([...Object.keys(NUMBER_WORDS), ...Object.keys(NUMBER_SCALES), 'point', 'and']);
  for (let index = 0; index < tokens.length; index++) {
    const foldedWord = /^([a-z]+)fold$/.exec(tokens[index]!.word)?.[1];
    const firstWord = foldedWord ?? tokens[index]!.word;
    if (!Object.hasOwn(NUMBER_WORDS, firstWord)) continue;
    const words: string[] = [firstWord];
    let cursor = index + 1;
    while (!foldedWord && cursor < tokens.length && known.has(tokens[cursor]!.word)) {
      const word = tokens[cursor]!.word;
      if (word === 'and' && words.length === 0) break;
      words.push(word);
      cursor++;
    }
    if (words.at(-1) === 'and' || words.at(-1) === 'point') continue;
    const value = parseNumberWords(words);
    if (value === undefined || !Number.isFinite(value)) continue;
    const start = tokens[index]!.start;
    const end = tokens[cursor - 1]!.end;
    const before = normalized.slice(Math.max(0, start - 64), start);
    const after = normalized.slice(end, Math.min(normalized.length, end + 24));
    const currencyPrefix = /\b([A-Z]{3})\s*$/.exec(before)?.[1];
    const currencySuffix = /^\s*([A-Z]{3})\b/.exec(after)?.[1];
    const currencyWord = /\b(?:dollars?|euros?|pounds?|yen|rupiahs?)\b/i.test(after);
    const symbolBefore = /([$€£¥₹₩₽])\s*$/.exec(before)?.[1];
    const nearUnit = foldedWord !== undefined || /\b(?:percent(?:age)?|times?|fold|bps|basis\s+points?)\b/i.test(after)
      || currencyWord || symbolBefore !== undefined
      || (currencyPrefix !== undefined && CURRENCY_CODES.has(currencyPrefix))
      || (currencySuffix !== undefined && CURRENCY_CODES.has(currencySuffix));
    const financialFrame = hasMetricValueFrame(normalized, start, end);
    if (!nearUnit && !financialFrame) continue;
    let unit: NumberAssertion['unit'];
    if (/\b(?:percent(?:age)?)\b/i.test(after)) unit = 'percent';
    else if (foldedWord !== undefined || /\b(?:times?|fold)\b/i.test(after)) unit = 'multiple';
    else if (/\b(?:bps|basis\s+points?)\b/i.test(after)) unit = 'bps';
    const currencyMatch = /\b([A-Z]{3})\b\s*$/.exec(before);
    const currencyCode = currencyMatch && CURRENCY_CODES.has(currencyMatch[1]!) ? currencyMatch[1]!
      : currencySuffix && CURRENCY_CODES.has(currencySuffix) ? currencySuffix : undefined;
    output.push({ value, start, end, unit, ...(currencyCode ? { currencyCode } : {}), ...(currencyWord ? { currencySymbol: 'currency-word' } : {}), ...(symbolBefore ? { currencySymbol: symbolBefore } : {}) });
    index = cursor - 1;
  }
  return output;
}

function numericAssertions(text: string): NumberAssertion[] {
  const out: NumberAssertion[] = [];
  const periodRanges = [...text.matchAll(/\b(?:19|20)\d{2}-Q[1-4]\b|\b\d{4}-\d{2}-\d{2}\b|\bQ[1-4]\s+(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\s+Q[1-4]\b/g)]
    .map(match => [match.index!, match.index! + match[0]!.length] as const);
  const pattern = /(?<![\w.])(-?\d[\d,]*(?:\.\d+)?)(?:\s*(%|x|times?|bps))?(?![\w])/gi;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    const end = start + match[0]!.length;
    if (periodRanges.some(([left, right]) => start < right && end > left)) continue;
    const value = Number(match[1]!.replaceAll(',', ''));
    if (!Number.isFinite(value)) continue;
    const before = text.slice(Math.max(0, start - 64), start);
    const currencyMatch = /\b([A-Z]{3})\s*$/.exec(before);
    const after = text.slice(end, Math.min(text.length, end + 16));
    const currencySuffix = /^\s*([A-Z]{3})\b/.exec(after)?.[1];
    const currencyCode = currencyMatch && CURRENCY_CODES.has(currencyMatch[1]!) ? currencyMatch[1]!
      : currencySuffix && CURRENCY_CODES.has(currencySuffix) ? currencySuffix : undefined;
    const currencySymbol = /([$€£¥₹₩₽])\s*$/.exec(before)?.[1];
    const marker = match[2]?.toLowerCase();
    const hasUnit = marker !== undefined || currencyCode !== undefined || currencySymbol !== undefined;
    const hasFinancialFrame = hasMetricValueFrame(text, start, end);
    if (!hasUnit && !hasFinancialFrame) continue;
    out.push({
      value,
      start,
      end,
      ...(marker === '%' ? { unit: 'percent' as const } : marker === 'x' || marker?.startsWith('time') ? { unit: 'multiple' as const } : marker ? { unit: 'bps' as const } : {}),
      ...(currencyCode ? { currencyCode } : {}),
      ...(currencySymbol ? { currencySymbol } : {}),
    });
  }
  out.push(...numberWordAssertions(text));
  return out.sort((left, right) => left.start - right.start || left.end - right.end);
}

function assertFigureUnits(assertion: NumberAssertion, figure: ChallengeCitedFigure): void {
  if (assertion.currencySymbol) invalidOutput('Challenge financial amounts require an explicit currency code, not a symbol or currency word');
  if (figure.unitClass === 'percent' && assertion.unit !== 'percent') {
    invalidOutput('Percent-valued metrics require an explicit percent unit');
  }
  if (figure.unitClass === 'currency' && (!figure.currencyCode || assertion.currencyCode !== figure.currencyCode)) {
    invalidOutput('Currency-valued metrics require the matching currency code');
  }
  if (assertion.unit) {
    if (assertion.unit === 'percent' && figure.unitClass !== 'percent') invalidOutput('Numeric statement gives a financial figure the wrong unit');
    if (assertion.unit === 'multiple' && figure.unitClass !== 'multiple') invalidOutput('Numeric statement gives a financial figure the wrong unit');
    if (assertion.unit === 'bps') invalidOutput('Basis-point assertions require a basis-point source value');
  }
  if (assertion.currencyCode && (figure.unitClass !== 'currency' || figure.currencyCode !== assertion.currencyCode)) {
    invalidOutput('Numeric statement gives a financial figure the wrong currency');
  }
}

function metricForAssertion(assertion: NumberAssertion, figures: ChallengeCitedFigure[]): ChallengeCitedFigure | undefined {
  const matches = figures.filter(figure => assertion.value === figure.value);
  if (matches.length === 0) return undefined;
  const first = matches[0]!;
  return matches.every(figure => figure.metric === first.metric && figure.unitClass === first.unitClass
    && figure.currencyCode === first.currencyCode) ? first : undefined;
}

function metricMentionNearAssertion(statement: string, assertion: NumberAssertion): ChallengeMetric | undefined {
  let clauseStart = 0;
  let clauseEnd = statement.length;
  const boundary = /[!?;]|\.(?=\s|$)/g;
  for (const match of statement.matchAll(boundary)) {
    const afterBoundary = match.index! + match[0]!.length;
    if (afterBoundary <= assertion.start) clauseStart = afterBoundary;
    else if (match.index! >= assertion.end) {
      clauseEnd = match.index!;
      break;
    }
  }

  const clause = statement.slice(clauseStart, clauseEnd);
  const mentions: Array<{ metric: ChallengeMetric; distance: number }> = [];
  for (const [metric, pattern] of METRIC_PATTERNS) {
    const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of clause.matchAll(matcher)) {
      const start = clauseStart + match.index!;
      const end = start + match[0]!.length;
      mentions.push({ metric, distance: assertion.start < start ? start - assertion.start : assertion.start > end ? assertion.start - end : 0 });
    }
  }
  if (mentions.length === 0) return undefined;
  const closestDistance = Math.min(...mentions.map(mention => mention.distance));
  const closestMetrics = new Set(mentions.filter(mention => mention.distance === closestDistance).map(mention => mention.metric));
  return closestMetrics.size === 1 ? [...closestMetrics][0] : undefined;
}

function validateDirectionalChanges(statement: string, figures: ChallengeCitedFigure[]): void {
  for (const clause of relationClauses(statement)) {
    const changes = [...clause.matchAll(new RegExp(CHANGE_ASSERTION.source, `${CHANGE_ASSERTION.flags}g`))];
    const assertions = numericAssertions(clause);
    if (changes.length === 0 || assertions.length === 0) continue;
    if (changes.length !== 1) invalidOutput('Each directional change must be independently grounded');

    const verb = changes[0]![0]!.toLowerCase();
    const direction = changeDirection(verb);
    if (direction === undefined) invalidOutput('Challenge directional change uses an unsupported verb');

    if (/\bfrom\b[^!?;]*?\bto\b/i.test(clause)) {
      const phrase = clause.slice(changes[0]!.index!).split(/[!?;]|\.(?=\s|$)/, 1)[0]!;
      const endpoints = numericAssertions(phrase);
      const matched = endpoints.map(assertion => metricForAssertion(assertion, figures));
      const statedMetrics = endpoints.map(assertion => metricMentionNearAssertion(clause, assertion));
      if (endpoints.length !== 2 || matched[0] === undefined || matched[1] === undefined
        || matched[0].metric !== matched[1].metric || matched[0].unitClass !== matched[1].unitClass
        || matched[0].currencyCode !== matched[1].currencyCode
        || matched[0].periodLabel === matched[1].periodLabel
        || statedMetrics[0] !== matched[0].metric || statedMetrics[1] !== matched[1].metric) {
        invalidOutput('Directional comparison requires two distinct grounded observations of the same metric');
      }
      const change = matched[1]!.value - matched[0]!.value;
      if ((direction > 0 && change <= 0) || (direction < 0 && change >= 0)) {
        invalidOutput('Directional comparison contradicts the grounded observations');
      }
      continue;
    }

    if (assertions.length !== 1 || !REPORTED_YOY_CHANGE_VERBS.has(verb)
      || !/\b(?:yoy|year[-\s]+over[-\s]+year)\b/i.test(clause)) {
      invalidOutput('A directional change requires two grounded endpoints or a directly reported YoY growth metric');
    }
    const figure = metricForAssertion(assertions[0]!, figures);
    const statedMetric = metricMentionNearAssertion(clause, assertions[0]!);
    const isRevenueGrowth = figure?.metric === 'revenueGrowthYoy'
      && (statedMetric === 'revenue' || statedMetric === 'revenueGrowthYoy');
    const isIncomeGrowth = figure?.metric === 'netIncomeGrowthYoy'
      && (statedMetric === 'netIncome' || statedMetric === 'netIncomeGrowthYoy');
    if (!figure || (!isRevenueGrowth && !isIncomeGrowth)
      || (direction > 0 && figure.value <= 0) || (direction < 0 && figure.value >= 0)) {
      invalidOutput('YoY growth direction must agree with the directly reported grounded value');
    }
  }
}

function valueAtPath(item: GroundedEvidence, path: string): number {
  const actual = numericValueAtPath(item.evidence.data, path);
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    invalidOutput(`Challenge cited Evidence path ${path} without a finite numeric value`);
  }
  return actual;
}

function validateStatement(statement: string, figures: ChallengeCitedFigure[]): void {
  if (hasUnavailableVerdict(statement)) invalidOutput('Challenge findings cannot state a ranking, winner, score, or recommendation');
  assertNoUnsupportedRelations(statement, true);
  const assertions = numericAssertions(statement);
  if (assertions.length === 0) return;
  if (IMPLICIT_BOUND.test(statement)) invalidOutput('Challenge findings cannot turn an exact observation into an unsupported bound');
  for (const assertion of assertions) {
    const figure = metricForAssertion(assertion, figures);
    if (!figure) invalidOutput('Challenge numeric assertion has no matching grounded CitedFigure');
    const statedMetric = metricMentionNearAssertion(statement, assertion);
    if (!statedMetric) invalidOutput('Challenge numeric assertion does not name its financial metric');
    const yoy = /\b(?:yoy|year[-\s]+over[-\s]+year)\b/i.test(statement);
    const directGrowthMetric = yoy && ((statedMetric === 'revenue' && figure.metric === 'revenueGrowthYoy')
      || (statedMetric === 'netIncome' && figure.metric === 'netIncomeGrowthYoy'));
    if (statedMetric !== figure.metric && !directGrowthMetric) invalidOutput('Challenge numeric assertion is linked to a different financial metric');
    assertFigureUnits(assertion, figure);
    if (!financialAssertionMatches({
      assertion: { ...assertion, metric: statedMetric },
      figure,
      statedMetric: figure.metric,
    })) invalidOutput('Challenge numeric assertion has incompatible financial semantics');
  }

  validateDirectionalChanges(statement, figures);
}

function allTextFields(output: ChallengeAnalystOutput): string[] {
  return [
    output.summary,
    ...output.unsupportedAssumptions,
    ...output.failureConditions,
    ...output.evidenceThatWouldChangeThesis,
    ...output.sourceAssessments.map(item => item.rationale),
    ...output.gaps,
  ];
}

/** Validates a Challenger response against only financial Evidence accepted for this Execution. */
export async function groundChallengeOutput(params: {
  executionId: string;
  ticker: string;
  thesis: string;
  output: unknown;
  seenEvidenceIds: readonly string[];
  evidenceStore: Pick<EvidenceStore, 'getManyByIdsForRun'>;
  signal?: AbortSignal;
}): Promise<ChallengeReportPayload> {
  if (typeof params.executionId !== 'string' || typeof params.ticker !== 'string' || typeof params.thesis !== 'string'
    || !Array.isArray(params.seenEvidenceIds)) {
    throw new ChallengeGroundingError('INVALID_INPUT', 'Challenge grounding received malformed input');
  }
  const executionId = params.executionId.trim();
  const ticker = params.ticker.trim().toUpperCase();
  const thesis = params.thesis.trim();
  if (!executionId || !/^[A-Z]{2,6}$/.test(ticker) || !thesis) {
    throw new ChallengeGroundingError('INVALID_INPUT', 'Challenge grounding requires an Execution, IDX ticker, and explicit thesis');
  }

  const seen = new Set<string>();
  for (const id of params.seenEvidenceIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || seen.has(id)) {
      throw new ChallengeGroundingError('INVALID_INPUT', 'Challenge grounding received malformed or duplicate supplied Evidence IDs');
    }
    seen.add(id);
  }

  assertNotAborted(params.signal);

  let output: ChallengeAnalystOutput;
  try {
    output = ChallengeAnalystOutputSchema.parse(params.output);
  } catch (cause) {
    throw new ChallengeGroundingError('INVALID_OUTPUT', 'Challenge Analyst output does not match its strict contract', { cause });
  }
  if (output.thesis.trim() !== thesis) invalidOutput('Challenge Analyst changed the supplied thesis');

  const findingIdSet = new Set<string>();
  for (const finding of [...output.supportingCase, ...output.counterCase]) {
    for (const id of finding.evidenceIds) {
      if (!seen.has(id)) invalidOutput(`Challenge finding Evidence ${id} was not supplied to the analyst`);
      findingIdSet.add(id);
    }
    for (const figure of finding.citedFigures ?? []) {
      if (!seen.has(figure.evidenceId) || !finding.evidenceIds.includes(figure.evidenceId)) {
        invalidOutput(`CitedFigure Evidence ${figure.evidenceId} is not linked to its Challenge finding`);
      }
      findingIdSet.add(figure.evidenceId);
    }
  }

  const assessmentIds = new Set<string>();
  for (const assessment of output.sourceAssessments) {
    if (!seen.has(assessment.evidenceId) || assessmentIds.has(assessment.evidenceId)) {
      invalidOutput(`Challenge source assessment Evidence ${assessment.evidenceId} is missing, duplicated, or out of scope`);
    }
    assessmentIds.add(assessment.evidenceId);
  }
  const coverageByEvidence = new Map<string, string>();
  for (const coverage of output.coverage) {
    for (const id of coverage.evidenceIds) {
      if (!seen.has(id) || coverageByEvidence.has(id)) invalidOutput(`Challenge coverage Evidence ${id} is duplicated or out of scope`);
      coverageByEvidence.set(id, coverage.source);
    }
  }

  for (const id of findingIdSet) {
    if (!assessmentIds.has(id)) invalidOutput(`Challenge finding Evidence ${id} has no source assessment`);
    if (!coverageByEvidence.has(id)) invalidOutput(`Challenge finding Evidence ${id} has no source coverage`);
  }
  for (const id of assessmentIds) {
    if (!coverageByEvidence.has(id)) invalidOutput(`Challenge source assessment Evidence ${id} has no source coverage`);
  }

  for (const statement of allTextFields(output)) {
    if (hasUnavailableVerdict(statement)) invalidOutput('Challenge output cannot state a ranking, winner, score, or recommendation');
    assertNoUnsupportedRelations(statement);
    if (numericAssertions(statement).length > 0) invalidOutput('Numeric assertions must appear in a finding with exact cited Evidence');
  }

  const requestedIds = [...params.seenEvidenceIds];
  if (requestedIds.length === 0) invalidOutput('Challenge report has no accepted Evidence references');
  let loaded: Evidence[];
  try {
    loaded = await params.evidenceStore.getManyByIdsForRun(executionId, requestedIds);
  } catch (cause) {
    if (params.signal?.aborted) assertNotAborted(params.signal);
    throw new ChallengeGroundingError('VALIDATION_UNAVAILABLE', 'Challenge Evidence scope could not be read', { cause });
  }
  assertNotAborted(params.signal);
  if (!Array.isArray(loaded)) invalidEvidence('Challenge Evidence scope returned an invalid result');
  const byId = new Map<string, GroundedEvidence>();
  for (const rawEvidence of loaded as unknown[]) {
    if (!isRecord(rawEvidence) || typeof rawEvidence.id !== 'string') {
      invalidEvidence('Challenge Evidence scope returned a malformed Evidence row');
    }
    const evidence = rawEvidence as unknown as Evidence;
    if (!requestedIds.includes(evidence.id) || byId.has(evidence.id)) {
      invalidEvidence('Challenge Evidence scope returned an extra or duplicate Evidence row');
    }
    byId.set(evidence.id, validateAcceptedEvidence(evidence, executionId, ticker));
  }
  for (const id of requestedIds) {
    if (!byId.has(id)) invalidEvidence(`Evidence ${id} is outside Execution ${executionId} membership`);
  }
  for (const id of requestedIds) {
    if (!assessmentIds.has(id)) invalidOutput(`Supplied Evidence ${id} has no source assessment`);
    if (!coverageByEvidence.has(id)) invalidOutput(`Supplied Evidence ${id} has no source coverage`);
  }

  for (const [id, source] of coverageByEvidence) {
    if (byId.get(id)!.evidence.source !== source) invalidOutput(`Challenge coverage source ${source} does not match Evidence ${id}`);
  }

  const groundedFindings = [...output.supportingCase, ...output.counterCase].map(finding => {
    const groundedFigures: ChallengeCitedFigure[] = [];
    const seenFigures = new Set<string>();
    for (const cited of finding.citedFigures ?? []) {
      const key = `${cited.evidenceId}\u0000${cited.path}`;
      if (seenFigures.has(key)) invalidOutput(`Challenge finding repeats CitedFigure ${cited.evidenceId}:${cited.path}`);
      seenFigures.add(key);
      const item = byId.get(cited.evidenceId);
      if (!item) invalidEvidence(`CitedFigure Evidence ${cited.evidenceId} is outside Execution scope`);
      const source = parseFinancialPath(cited.path, item);
      if (cited.value !== source.value) invalidOutput(`CitedFigure value does not match Evidence path ${cited.path}`);
      if (cited.periodLabel !== source.periodLabel) invalidOutput(`CitedFigure period does not match Evidence path ${cited.path}`);
      groundedFigures.push({
        evidenceId: cited.evidenceId,
        path: cited.path,
        value: source.value,
        periodLabel: source.periodLabel,
        metric: source.metric,
        unitClass: source.unitClass,
        ...(source.currencyCode ? { currencyCode: source.currencyCode } : {}),
      });
    }
    validateStatement(finding.statement, groundedFigures);
    return {
      statement: finding.statement,
      evidenceIds: finding.evidenceIds,
      confidence: finding.confidence,
      ...(finding.citedFigures !== undefined ? { citedFigures: groundedFigures } : {}),
    };
  });

  const firstSupporting = output.supportingCase.length;
  const payload = {
    thesis,
    summary: output.summary,
    supportingCase: groundedFindings.slice(0, firstSupporting),
    counterCase: groundedFindings.slice(firstSupporting),
    unsupportedAssumptions: output.unsupportedAssumptions,
    failureConditions: output.failureConditions,
    evidenceThatWouldChangeThesis: output.evidenceThatWouldChangeThesis,
    sourceAssessments: output.sourceAssessments,
    gaps: output.gaps,
    coverage: output.coverage,
  };
  try {
    return ChallengeReportPayloadSchema.parse(payload);
  } catch (cause) {
    throw new ChallengeGroundingError('INVALID_OUTPUT', 'Grounded Challenge payload does not match its domain schema', { cause });
  }
}
