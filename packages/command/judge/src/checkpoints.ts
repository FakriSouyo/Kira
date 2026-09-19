import type {
  CompanyReport,
  DailyTransaction,
  Filing,
  ForeignFlow,
  FinancialDataResult,
  NewsArticle,
  QuarterlyFinancials,
  Sentiment,
} from '@harness/financial-data';
import type { Claim, Evidence, Judgment, BearCounterpoint } from '@harness/schemas';
import type { JsonValue } from '@harness/session-core';
import type { JudgeNodeId } from './definition.js';

export const JUDGE_CHECKPOINT_OUTPUT_KINDS: Record<JudgeNodeId, string> = {
  'identify-company': 'judge.company-report.v1',
  'fetch-financials': 'judge.quarterly-financials.v1',
  'fetch-market-data': 'judge.market-data.v1',
  'fetch-news': 'judge.news-data.v1',
  'collect-sources': 'judge.collected-sources.v1',
  'select-supporting-evidence': 'judge.evidence-selection.v1',
  'round-1-bull-thesis': 'judge.bull-thesis.v1',
  'round-1-bear-challenge': 'judge.bear-challenge.v1',
  'round-2-bull-rebuttal': 'judge.bull-rebuttal.v1',
  'evaluate-arguments': 'judge.evaluation.v1',
  'conditional-bear-rechallenge': 'judge.conditional-bear.v1',
  'conditional-bull-rebuttal': 'judge.conditional-bull.v1',
  'resolve-conflicts': 'judge.resolution.v1',
  'check-evidence': 'judge.evidence-audit.v1',
  'synthesize-verdict': 'judge.verdict.v1',
};

export function checkpointKindForNode(nodeId: JudgeNodeId): string {
  return JUDGE_CHECKPOINT_OUTPUT_KINDS[nodeId];
}

export interface JudgeModelCallAudit {
  provider: string;
  model: string;
  providerId?: string;
  modelId?: string;
  adapterId?: string;
  protocol?: string;
  runtimeFingerprint?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  latencyMs: number;
}

export interface JudgeModelAudit {
  subagent: string;
  skills: Array<{ name: string; contentHash: string }>;
  modelCall?: JudgeModelCallAudit;
  contextSnapshotId?: string | null;
}

export type JudgeFinancialCheckpoint = FinancialDataResult<CompanyReport>;
export type JudgeQuarterlyCheckpoint = FinancialDataResult<QuarterlyFinancials>;
export type JudgeMarketCheckpoint =
  | { outcome: 'succeeded'; daily: FinancialDataResult<DailyTransaction>; foreign: FinancialDataResult<ForeignFlow> }
  | { outcome: 'optional-failure'; errorCode: string };
export type JudgeNewsCheckpoint =
  | { outcome: 'succeeded'; news: FinancialDataResult<NewsArticle[]>; filings: FinancialDataResult<Filing[]>; sentiment: FinancialDataResult<Sentiment> }
  | { outcome: 'optional-failure'; errorCode: string };

export interface JudgeCollectedSourcesCheckpoint {
  snapshotId: string;
  snapshotFingerprint: string;
  evidenceIds: string[];
  marketEvidenceIds: string[];
  newsEvidenceIds: string[];
  marketAvailable: boolean;
  newsAvailable: boolean;
}

export interface JudgeEvidenceSelectionCheckpoint {
  evidenceIds: string[];
  marketAvailable: boolean;
  newsAvailable: boolean;
}

export interface JudgeBullCheckpoint {
  response: JsonValue;
  claims: Claim[];
  audit: JudgeModelAudit;
}

export interface JudgeBearCheckpoint {
  response: JsonValue;
  counterpoints: BearCounterpoint[];
  audit: JudgeModelAudit;
}

export interface JudgeEvaluationCheckpoint {
  judgment: Judgment;
  allClaims: Claim[];
  needsExtra: boolean;
  audit: JudgeModelAudit;
}

export interface JudgeEvidenceAuditCheckpoint {
  claims: number;
  challenges: number;
  evidenceIds: string[];
}

export interface JudgeVerdictCheckpoint {
  judgment: Judgment;
  rounds: number;
}

export type JudgeCheckpointPayload =
  | JudgeFinancialCheckpoint
  | JudgeQuarterlyCheckpoint
  | JudgeMarketCheckpoint
  | JudgeNewsCheckpoint
  | JudgeCollectedSourcesCheckpoint
  | JudgeEvidenceSelectionCheckpoint
  | JudgeBullCheckpoint
  | JudgeBearCheckpoint
  | JudgeEvaluationCheckpoint
  | JudgeEvidenceAuditCheckpoint
  | JudgeVerdictCheckpoint
  | Evidence[];
