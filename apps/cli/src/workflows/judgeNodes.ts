import type { BearCounterpoint, BearLLMOutput, BullLLMOutput, Claim, Evidence, Judgment } from '@harness/schemas';
import type { JudgeNodeExecutors, JudgeNodeId, JudgeRoundDecision } from '@harness/command-judge';
import type { SubagentResult } from '@harness/subagent-core';
import { assembleSpecialistContext, type SpecialistContextPacket, type SpecialistPhase, type SpecialistRole } from '@harness/context';
import {
  createNotRequestedObservation,
  createUnavailableObservation,
  createVerifiedFinancialSnapshot,
  verifyFinancialObservation,
  type CompanyReport,
  type DailyTransaction,
  type Filing,
  type FinancialDataResult,
  type FinancialObservation,
  type ForeignFlow,
  type NewsArticle,
  type QuarterlyFinancials,
  type Sentiment,
  type PresentFinancialObservation,
} from '@harness/financial-data';
import { SECTORS_SOURCES } from '@harness/sectors-api';
import { buildEvidenceZone, normalizeJudgmentScore, stanceForScore, UserFriendlyError, ValidationError } from '@harness/shared';
import type { AgentEvent, AgentToolName } from '../repl/events';
import type { HarnessContext } from '../context';

/** Phase shown by progress renderers; the composition layer re-exports it for events.ts. */
export type JudgeProgressPhase = 'researcher' | 'bull' | 'bear' | 'judge';
export type JudgeProgress = (phase: JudgeProgressPhase, line: string) => void;

/** Public, renderer-ready responses. `messageId` matches the persisted conversation message. */
export interface BullAnalysisResponse extends BullLLMOutput { messageId: string }
export interface BearChallengeResponse extends BearLLMOutput { messageId: string }

/** Durable subscriber for node results (workflow_steps/model_calls). One stream, no second truth. */
export interface JudgeNodeTrace {
  recordSubagentResult(nodeId: string, result: SubagentResult<unknown>): Promise<void>;
}

/** Everything the adapters need from the CLI composition layer. */
export interface JudgeRunDeps {
  ctx: HarnessContext;
  ticker: string;
  runId: string;
  events: (event: AgentEvent) => void;
  progress: JudgeProgress;
  /** Written by the round-1 verdict node, read by `enabled` predicates of the conditional nodes. */
  decision: JudgeRoundDecision;
  /** Reasoning mode always runs the arbitration round; `--conditional` opens it for a neutral verdict. */
  reasoning: boolean;
  conditional: boolean;
  /** Immutable profile flags for resumed executions; fresh runs use ctx.researchers. */
  researchers?: { market: boolean; news: boolean };
  executionStartedAt?: string;
  trace?: JudgeNodeTrace;
  /** Semantic checkpoint commit before model-node projections are written. */
  checkpoint?: (nodeId: JudgeNodeId, value: unknown) => Promise<void>;
  /** Rehydrated closure state needed by later nodes when earlier model nodes are restored. */
  restored?: {
    round1BearCounterpoints?: BearCounterpoint[];
    conditionalBearCounterpoints?: BearCounterpoint[];
  };
  lifecycle?: { sessionId: string; turnId: string };
}

export interface CollectedSources {
  evidence: Evidence[];
  evidenceIds: string[];
  marketEvidence: Evidence[];
  newsEvidence: Evidence[];
  marketAvailable: boolean;
  newsAvailable: boolean;
  financialSnapshotId?: string;
}

export interface EvidenceSelection {
  evidenceZone: string;
  evidence: Evidence[];
  evidenceIds: string[];
  marketAvailable: boolean;
  newsAvailable: boolean;
}

export interface ThesisTurn {
  response: BullAnalysisResponse;
  claims: Claim[];
  result: SubagentResult<unknown>;
}

export interface ChallengeTurn {
  response: BearChallengeResponse;
  result: SubagentResult<unknown>;
}

export interface JudgeTurn {
  judgment: Judgment;
  allClaims: Claim[];
  /** Inconclusive round-1 verdict → the conditional arbitration round must reopen the debate. */
  needsExtra: boolean;
  result: SubagentResult<unknown>;
}

export interface SynthesisTurn {
  judgment: Judgment;
  rounds: number;
}

/** Evidence release gate result: scope re-derived from what the run actually persisted. */
export interface EvidenceAudit {
  claims: number;
  challenges: number;
  evidenceIds: string[];
}

const ABORT_SUGGESTION = 'Run cancelled at phase boundary';

/** Abort check at node boundaries — the same contract the manual pipeline enforced. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new UserFriendlyError('ABORTED', 'Aborted', ABORT_SUGGESTION);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Emit public, auditable text without exposing private chain-of-thought. */
function emitPublicText(
  events: (event: AgentEvent) => void,
  agent: 'bull' | 'bear' | 'judge' | 'researcher',
  text: string,
  targetChunks = 1,
): void {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunkCount = Math.min(targetChunks, words.length);
  if (chunkCount <= 1) {
    if (text) events({ type: 'agent.text', agent, text });
    return;
  }
  for (let index = 0; index < chunkCount; index += 1) {
    const start = Math.floor((index * words.length) / chunkCount);
    const end = Math.floor(((index + 1) * words.length) / chunkCount);
    events({ type: 'agent.text', agent, text: words.slice(start, end).join('') });
  }
}

function nodeValue<T>(inputs: Readonly<Record<string, unknown>>, nodeId: JudgeNodeId): T {
  return inputs[nodeId] as T;
}

function optionalValue<T>(inputs: Readonly<Record<string, unknown>>, nodeId: JudgeNodeId): T | undefined {
  return inputs[nodeId] as T | undefined;
}

/** Persisted challenge text — reasoning plus one line per counterpoint (audit format). */
function challengeContent(response: BearChallengeResponse): string {
  return response.reasoning +
    '\n' +
    response.counterpoints
      .map((counterpoint, index) => `Challenge #${index + 1} (targets claim ${counterpoint.targetClaimId}, strength ${counterpoint.strength}): ${counterpoint.argument}`)
      .join('\n');
}

/**
 * Node adapters for `/judge`. Each entry performs exactly the work (fetch,
 * persistence, validation, event emission) the manual pipeline performed at that
 * stage; `WorkflowRunner` owns ordering, required/optional semantics, and
 * cancellation. All model authority stays in the subagents and every persistence
 * side effect stays in this composition layer.
 */
export function createJudgeNodeExecutors(deps: JudgeRunDeps): JudgeNodeExecutors {
  const { ctx, ticker, runId, events, progress, decision } = deps;
  const researchers = deps.researchers ?? ctx.researchers;

  const tool = async <T>(name: AgentToolName, signal: AbortSignal | undefined, fetcher: () => Promise<T>): Promise<T> => {
    assertNotAborted(signal);
    events({ type: 'tool.start', tool: name, ticker, agent: 'researcher' });
    const started = Date.now();
    let failure: string | undefined;
    try {
      const value = await fetcher();
      assertNotAborted(signal);
      return value;
    } catch (error) {
      failure = errorMessage(error);
      throw error;
    } finally {
      events({ type: 'tool.complete', tool: name, agent: 'researcher', durationMs: Date.now() - started, ...(failure ? { error: failure } : {}) });
    }
  };

  const stableErrorCode = (error: unknown): string => {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
    if (error instanceof Error && error.name && error.name !== 'Error') return error.name;
    return 'PROVIDER_ERROR';
  };

  const saveEvidence = async (source: string, data: unknown): Promise<Evidence> => {
    const persisted = await ctx.db.evidence.save({ runId, ticker, source, data: data as Record<string, unknown> });
    events({ type: 'evidence.found', id: persisted.id, source });
    // A deduplicated immutable provider row may retain its original owner run;
    // the runEvidence membership still makes it current execution Evidence.
    return persisted.runId === runId ? persisted : { ...persisted, runId };
  };

  const materialize = async <K extends FinancialObservation['kind']>(
    observation: PresentFinancialObservation<K>,
    source: string,
  ): Promise<{ observation: PresentFinancialObservation<K>; evidence: Evidence }> => {
    const evidence = await saveEvidence(source, observation.data);
    return { observation: { ...observation, evidenceIds: [evidence.id] }, evidence };
  };

  const record = async (nodeId: JudgeNodeId, result: SubagentResult<unknown>): Promise<void> => {
    if (deps.trace) await deps.trace.recordSubagentResult(nodeId, result);
  };
  const checkpoint = async (nodeId: JudgeNodeId, value: unknown): Promise<void> => {
    await deps.checkpoint?.(nodeId, value);
  };
  let round1BearCounterpoints: BearCounterpoint[] = deps.restored?.round1BearCounterpoints ?? [];
  let conditionalBearCounterpoints: BearCounterpoint[] = deps.restored?.conditionalBearCounterpoints ?? [];
  let marketFailureCode: string | undefined;
  let newsFailureCode: string | undefined;

  const specialistContext = (params: {
    role: SpecialistRole;
    phase: SpecialistPhase;
    roundNumber: number;
    evidence: Evidence[];
    bullClaims?: Claim[];
    bearCounterpoints?: BearCounterpoint[];
    rebuttalClaims?: Claim[];
    discussion?: { agent: string; type: string; content: string }[];
    availableCategories?: { marketMomentum: boolean; risk: boolean };
  }): SpecialistContextPacket | undefined => deps.lifecycle
    ? assembleSpecialistContext({
      sessionId: deps.lifecycle.sessionId,
      turnId: deps.lifecycle.turnId,
      executionId: runId,
      ticker,
      ...params,
    })
    : undefined;

  /** Judge call shared by both verdict nodes: the discussion is the persisted conversation. */
  const evaluateArguments = async (params: {
    claims: Claim[];
    selection: EvidenceSelection;
    bullClaims: Claim[];
    bearCounterpoints: BearCounterpoint[];
    rebuttalClaims: Claim[];
    phase: 'EVALUATION' | 'RESOLUTION';
    roundNumber: number;
  }) => {
    const conversation = await ctx.db.conversation.getByRun(runId);
    const discussion = conversation.map((message) => ({ agent: message.agent, type: message.messageType, content: message.content }));
    const availableCategories = { marketMomentum: params.selection.marketAvailable, risk: params.selection.newsAvailable };
    const context = specialistContext({
      role: 'JUDGE', phase: params.phase, roundNumber: params.roundNumber, evidence: params.selection.evidence,
      bullClaims: params.bullClaims, bearCounterpoints: params.bearCounterpoints,
      rebuttalClaims: params.rebuttalClaims, discussion, availableCategories,
    });
    return context
      ? await ctx.judge.evaluate({ context })
      : await ctx.judge.evaluate({
        ticker, claims: params.claims, evidenceZone: params.selection.evidenceZone,
        discussion, availableCategories,
      });
  };

  return {
    /** Company Report — required ground truth; a failed request ends the run. */
    'identify-company': async (_inputs, signal) => {
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'researcher', label: "I'm starting with Company Report and Quarterly Financials." });
      events({ type: 'agent.start', agent: 'researcher' });
      progress('researcher', `I'm starting with Company Report and Quarterly Financials for ${ticker}...`);
      const report = await tool('company_report', signal, () => ctx.financialData.getCompanyReport(ticker));
      progress('researcher', '✓ Company Report retrieved');
      return report;
    },

    /** Quarterly Financials — required ground truth; a failed request ends the run. */
    'fetch-financials': async (_inputs, signal) => {
      const financials = await tool('quarterly_financials', signal, () => ctx.financialData.getQuarterlyFinancials(ticker));
      progress('researcher', '✓ Quarterly Financials retrieved');
      return financials;
    },

    /**
     * Daily Transaction + Foreign Flow. A failed source request degrades: the node
     * reports the failure (visible in the trace) and dependent evidence collection
     * sees no market data, so `marketMomentum` stays unevaluated.
     */
    'fetch-market-data': async (_inputs, signal) => {
      try {
        const daily = await tool('daily_transaction', signal, () => ctx.financialData.getDailyTransaction(ticker));
        const foreign = await tool('foreign_flow', signal, () => ctx.financialData.getForeignFlow(ticker));
        return { daily, foreign };
      } catch (error) {
        assertNotAborted(signal);
        marketFailureCode = stableErrorCode(error);
        const warning = '⚠ Market data unavailable — marketMomentum left unevaluated';
        progress('researcher', warning);
        events({ type: 'command.output', text: warning });
        throw error;
      }
    },

    /** News + Filings + Sentiment. Any failed source request degrades the whole group. */
    'fetch-news': async (_inputs, signal) => {
      try {
        const news = await tool('news', signal, () => ctx.financialData.getNews(ticker));
        const filings = await tool('filings', signal, () => ctx.financialData.getFilings(ticker));
        const sentiment = await tool('sentiment', signal, () => ctx.financialData.getSentiment(ticker));
        return { news, filings, sentiment };
      } catch (error) {
        assertNotAborted(signal);
        newsFailureCode = stableErrorCode(error);
        const warning = '⚠ News data unavailable — risk left unevaluated';
        progress('researcher', warning);
        events({ type: 'command.output', text: warning });
        throw error;
      }
    },

    /**
     * Persist whatever evidence arrived and record the researcher observation.
     * Absent market/news data stays absent evidence — never a silent zero — while a
     * persistence failure is required and therefore fails the run.
     */
    'collect-sources': async (inputs, signal) => {
      assertNotAborted(signal);
      const reportResult = nodeValue<FinancialDataResult<CompanyReport>>(inputs, 'identify-company');
      const financialsResult = nodeValue<FinancialDataResult<QuarterlyFinancials>>(inputs, 'fetch-financials');
      const market = optionalValue<{
        daily: FinancialDataResult<DailyTransaction>;
        foreign: FinancialDataResult<ForeignFlow>;
      }>(inputs, 'fetch-market-data');
      const news = optionalValue<{
        news: FinancialDataResult<NewsArticle[]>;
        filings: FinancialDataResult<Filing[]>;
        sentiment: FinancialDataResult<Sentiment>;
      }>(inputs, 'fetch-news');

      // Required verification is complete before any provider response is
      // materialized as Evidence. A malformed required payload therefore
      // cannot leak into the evidence store.
      const reportObservation = verifyFinancialObservation('company_report', reportResult, ticker);
      const financialsObservation = verifyFinancialObservation('quarterly_financials', financialsResult, ticker);
      const observations: FinancialObservation[] = [reportObservation, financialsObservation];
      const evidenceIds: string[] = [];
      let marketEvidence: Evidence[] = [];
      let newsEvidence: Evidence[] = [];
      let marketAvailable = false;
      let newsAvailable = false;

      const report = await materialize(reportObservation, SECTORS_SOURCES.companyReport);
      const financials = await materialize(financialsObservation, SECTORS_SOURCES.quarterlyFinancials);
      evidenceIds.push(report.evidence.id, financials.evidence.id);
      observations[0] = report.observation;
      observations[1] = financials.observation;

      if (!researchers.market) {
        observations.push(createNotRequestedObservation('daily_transaction'), createNotRequestedObservation('foreign_flow'));
      } else if (!market) {
        observations.push(
          createUnavailableObservation('daily_transaction', 'PROVIDER_ERROR', marketFailureCode),
          createUnavailableObservation('foreign_flow', 'PROVIDER_ERROR', marketFailureCode),
        );
      } else {
        let dailyObservation: ReturnType<typeof verifyFinancialObservation<'daily_transaction'>> | undefined;
        let foreignObservation: ReturnType<typeof verifyFinancialObservation<'foreign_flow'>> | undefined;
        try {
          dailyObservation = verifyFinancialObservation('daily_transaction', market.daily, ticker);
          foreignObservation = verifyFinancialObservation('foreign_flow', market.foreign, ticker);
        } catch (error) {
          observations.push(
            createUnavailableObservation('daily_transaction', 'VERIFICATION_FAILED', stableErrorCode(error)),
            createUnavailableObservation('foreign_flow', 'VERIFICATION_FAILED', stableErrorCode(error)),
          );
        }
        if (dailyObservation && foreignObservation) {
          const daily = await materialize(dailyObservation, SECTORS_SOURCES.dailyTransaction);
          const foreign = await materialize(foreignObservation, SECTORS_SOURCES.foreignFlow);
          marketEvidence = [daily.evidence, foreign.evidence];
          marketAvailable = true;
          evidenceIds.push(daily.evidence.id, foreign.evidence.id);
          observations.push(daily.observation, foreign.observation);
          progress('researcher', '✓ Market data (Daily Transaction + Foreign Flow) retrieved');
        }
      }

      if (!researchers.news) {
        observations.push(
          createNotRequestedObservation('news'),
          createNotRequestedObservation('filings'),
          createNotRequestedObservation('sentiment'),
        );
      } else if (!news) {
        observations.push(
          createUnavailableObservation('news', 'PROVIDER_ERROR', newsFailureCode),
          createUnavailableObservation('filings', 'PROVIDER_ERROR', newsFailureCode),
          createUnavailableObservation('sentiment', 'PROVIDER_ERROR', newsFailureCode),
        );
      } else {
        let newsObservation: ReturnType<typeof verifyFinancialObservation<'news'>> | undefined;
        let filingsObservation: ReturnType<typeof verifyFinancialObservation<'filings'>> | undefined;
        let sentimentObservation: ReturnType<typeof verifyFinancialObservation<'sentiment'>> | undefined;
        try {
          newsObservation = verifyFinancialObservation('news', news.news, ticker);
          filingsObservation = verifyFinancialObservation('filings', news.filings, ticker);
          sentimentObservation = verifyFinancialObservation('sentiment', news.sentiment, ticker);
        } catch (error) {
          observations.push(
            createUnavailableObservation('news', 'VERIFICATION_FAILED', stableErrorCode(error)),
            createUnavailableObservation('filings', 'VERIFICATION_FAILED', stableErrorCode(error)),
            createUnavailableObservation('sentiment', 'VERIFICATION_FAILED', stableErrorCode(error)),
          );
        }
        if (newsObservation && filingsObservation && sentimentObservation) {
          const item = await materialize(newsObservation, SECTORS_SOURCES.news);
          const filings = await materialize(filingsObservation, SECTORS_SOURCES.filings);
          const sentiment = await materialize(sentimentObservation, SECTORS_SOURCES.sentiment);
          newsEvidence = [item.evidence, filings.evidence, sentiment.evidence];
          newsAvailable = true;
          evidenceIds.push(item.evidence.id, filings.evidence.id, sentiment.evidence.id);
          observations.push(item.observation, filings.observation, sentiment.observation);
          progress('researcher', '✓ News / Filings / Sentiment retrieved');
        }
      }

      let financialSnapshotId: string | undefined;
      if (deps.lifecycle && deps.executionStartedAt) {
        assertNotAborted(signal);
        const snapshot = createVerifiedFinancialSnapshot({
          ...deps.lifecycle,
          executionId: runId,
          ticker,
          requestedAsOf: null,
          executionStartedAt: deps.executionStartedAt,
          finalizedAt: new Date().toISOString(),
          observations,
          materializedEvidenceIds: evidenceIds,
        });
        const persisted = await ctx.db.financialSnapshots.save(snapshot);
        financialSnapshotId = persisted.snapshotId;
      }

      await ctx.db.conversation.addMessage({
        runId, messageId: `researcher_${runId}`, agent: 'researcher', messageType: 'observation',
        content: `I retrieved the evidence for ${ticker} and stored it for this run.`,
        evidenceIds, sequenceOrder: 0, metadata: { marketAvailable, newsAvailable },
      });
      events({ type: 'agent.text', agent: 'researcher', text: `I identified ${evidenceIds.length} evidence items for ${ticker} and passed them to the debate.` });
      events({ type: 'agent.complete', agent: 'researcher' });
      return {
        evidence: [report.evidence, financials.evidence, ...marketEvidence, ...newsEvidence],
        evidenceIds, marketEvidence, newsEvidence, marketAvailable, newsAvailable, financialSnapshotId,
      } satisfies CollectedSources;
    },

    /** Build the shared evidence block (prompt-cache zone [1]) consumed by every debating agent. */
    'select-supporting-evidence': async (inputs) => {
      const collected = nodeValue<CollectedSources>(inputs, 'collect-sources');
      return {
        evidenceZone: buildEvidenceZone(ticker, collected.evidence),
        evidence: collected.evidence,
        evidenceIds: collected.evidenceIds,
        marketAvailable: collected.marketAvailable,
        newsAvailable: collected.newsAvailable,
      } satisfies EvidenceSelection;
    },

    /** Bull thesis with run-scoped validation before anything is persisted. */
    'round-1-bull-thesis': async (inputs, signal) => {
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'bull', label: 'Analyzing the evidence for a bullish thesis.' });
      events({ type: 'agent.start', agent: 'bull' });
      progress('bull', 'Analyzing the evidence for a bullish thesis...');
      const context = specialistContext({ role: 'BULL', phase: 'THESIS', roundNumber: 1, evidence: selection.evidence });
      const result = await ctx.bull.analyze(context ? { context } : { ticker, evidenceZone: selection.evidenceZone });
      const response: BullAnalysisResponse = { ...result.value, messageId: `bull_${runId}` };
      emitPublicText(events, 'bull', response.reasoning, 3);
      assertNotAborted(signal);
      ctx.validator.assertSeenEvidence(response.evidenceIds, selection.evidenceIds);
      const claims = await ctx.validator.validate(response.claims, selection.evidenceIds);
      // Invariant §24-B.1: a claim may only cite evidence the agent actually saw.
      ctx.validator.assertSeenEvidence(claims.flatMap((claim) => claim.evidenceIds), selection.evidenceIds);
      const turn = { response, claims, result } satisfies ThesisTurn;
      await checkpoint('round-1-bull-thesis', turn);
      await ctx.db.conversation.addMessage({
        runId, messageId: response.messageId, agent: 'bull', messageType: 'claim', content: response.reasoning,
        evidenceIds: response.evidenceIds, sequenceOrder: 1,
        metadata: { claimCount: claims.length, seenEvidenceIds: selection.evidenceIds },
      });
      for (const claim of claims) await ctx.db.claims.save({ runId, messageId: response.messageId, claim });
      events({ type: 'agent.complete', agent: 'bull' });
      progress('bull', `✓ ${claims.length} claim(s) validated and stored`);
      await record('round-1-bull-thesis', result);
      return turn;
    },

    /** Bear challenge against the Bull claims; counterpoints must target existing claim IDs. */
    'round-1-bear-challenge': async (inputs, signal) => {
      const thesis = nodeValue<ThesisTurn>(inputs, 'round-1-bull-thesis');
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'bear', label: 'Challenging the bullish thesis.' });
      events({ type: 'agent.start', agent: 'bear' });
      progress('bear', 'Challenging the bullish thesis...');
      const context = specialistContext({ role: 'BEAR', phase: 'CHALLENGE', roundNumber: 1, evidence: selection.evidence, bullClaims: thesis.claims });
      const result = await ctx.bear.challenge(context ? { context } : { ticker, evidenceZone: selection.evidenceZone, bullClaims: thesis.claims });
      const response: BearChallengeResponse = { ...result.value, messageId: `bear_${runId}` };
      events({ type: 'agent.text', agent: 'bear', text: response.reasoning });
      assertNotAborted(signal);
      ctx.validator.assertSeenEvidence(response.evidenceIds, selection.evidenceIds);
      await ctx.validator.validateChallenge(response.counterpoints, response.evidenceIds, {
        claimIds: thesis.claims.map((claim) => claim.claimId), evidenceIds: selection.evidenceIds,
      });
      round1BearCounterpoints = response.counterpoints;
      const turn = { response, result } satisfies ChallengeTurn;
      await checkpoint('round-1-bear-challenge', turn);
      await ctx.db.conversation.addMessage({
        runId, messageId: response.messageId, agent: 'bear', messageType: 'challenge',
        content: challengeContent(response), evidenceIds: response.evidenceIds, sequenceOrder: 2,
        metadata: { challengeCount: response.counterpoints.length, seenEvidenceIds: selection.evidenceIds },
      });
      events({ type: 'agent.complete', agent: 'bear' });
      progress('bear', `✓ ${response.counterpoints.length} challenge(s) validated`);
      await record('round-1-bear-challenge', result);
      return turn;
    },

    /** Mandatory Bull rebuttal answering the round-1 challenge. */
    'round-2-bull-rebuttal': async (inputs, signal) => {
      const challenge = nodeValue<ChallengeTurn>(inputs, 'round-1-bear-challenge');
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'bull', label: 'Responding to the challenges.' });
      events({ type: 'agent.start', agent: 'bull' });
      progress('bull', 'Responding to the challenges...');
      const bullClaims: Claim[] = (await ctx.db.claims.getByRun(runId)).map((claim) => ({
        claimId: claim.claimId,
        statement: claim.statement,
        confidence: claim.confidence,
        reasoning: claim.reasoning ?? 'Persisted validated claim reasoning is unavailable.',
        evidenceIds: claim.evidenceIds,
      }));
      const context = specialistContext({ role: 'BULL', phase: 'REBUTTAL', roundNumber: 1, evidence: selection.evidence, bullClaims, bearCounterpoints: challenge.response.counterpoints });
      const result = await ctx.bull.rebuttal(context ? { context } : { ticker, evidenceZone: selection.evidenceZone, bearCounterpoints: challenge.response.counterpoints });
      const response: BullAnalysisResponse = { ...result.value, messageId: `bull_rebuttal_${runId}` };
      emitPublicText(events, 'bull', response.reasoning, 3);
      assertNotAborted(signal);
      ctx.validator.assertSeenEvidence(response.evidenceIds, selection.evidenceIds);
      const validated = await ctx.validator.validate(response.claims, selection.evidenceIds);
      ctx.validator.assertSeenEvidence(validated.flatMap((claim) => claim.evidenceIds), selection.evidenceIds);
      // Normalisasi claimId rebuttal — UNIQUE(run_id, claim_id); prefix menandai asal claim.
      const claims: Claim[] = validated.map((claim, index) => ({ ...claim, claimId: `rebuttal_${index + 1}` }));
      const turn = { response, claims, result } satisfies ThesisTurn;
      await checkpoint('round-2-bull-rebuttal', turn);
      await ctx.db.conversation.addMessage({
        runId, messageId: response.messageId, agent: 'bull', messageType: 'response', content: response.reasoning,
        evidenceIds: response.evidenceIds, sequenceOrder: 3,
        metadata: { claimCount: claims.length, seenEvidenceIds: selection.evidenceIds },
      });
      for (const claim of claims) await ctx.db.claims.save({ runId, messageId: response.messageId, claim });
      events({ type: 'agent.complete', agent: 'bull' });
      progress('bull', `✓ ${claims.length} rebuttal claim(s) stored`);
      await record('round-2-bull-rebuttal', result);
      return turn;
    },

    /**
     * Round-1 verdict. JudgeAgent re-derives score and stance from the rubric, so
     * the model only supplies the per-category breakdown.
     */
    'evaluate-arguments': async (inputs, signal) => {
      const thesis = nodeValue<ThesisTurn>(inputs, 'round-1-bull-thesis');
      const rebuttal = nodeValue<ThesisTurn>(inputs, 'round-2-bull-rebuttal');
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'judge', label: 'Weighing the debate against the rubrik.' });
      events({ type: 'agent.start', agent: 'judge' });
      progress('judge', 'Weighing the debate against the rubrik...');
      const allClaims = [...thesis.claims, ...rebuttal.claims];
      const result = await evaluateArguments({
        claims: allClaims, selection, bullClaims: thesis.claims,
        bearCounterpoints: round1BearCounterpoints, rebuttalClaims: rebuttal.claims,
        phase: 'EVALUATION', roundNumber: 1,
      });
      const judgment = result.value;
      events({ type: 'agent.text', agent: 'judge', text: judgment.summary });
      assertNotAborted(signal);
      const turn = { judgment, allClaims, needsExtra: judgment.stance === 'neutral', result } satisfies JudgeTurn;
      await checkpoint('evaluate-arguments', turn);
      await ctx.db.judgments.save({ runId, judgment });
      await ctx.db.conversation.addMessage({
        runId, messageId: `judge_${runId}`, agent: 'judge', messageType: 'decision', content: judgment.summary,
        evidenceIds: [], sequenceOrder: 4,
        metadata: { score: judgment.score, stance: judgment.stance, seenEvidenceIds: selection.evidenceIds },
      });
      events({ type: 'agent.complete', agent: 'judge' });
      // A neutral round-1 verdict reopens the debate; Reasoning mode always does (gate predicate).
      decision.extraRound = judgment.stance === 'neutral';
      await record('evaluate-arguments', result);
      return { ...turn, needsExtra: decision.extraRound };
    },

    /** Conditional Bear re-challenge against the full claim set (round 1 + rebuttal). */
    'conditional-bear-rechallenge': async (inputs, signal) => {
      const thesis = nodeValue<ThesisTurn>(inputs, 'round-1-bull-thesis');
      const rebuttal = nodeValue<ThesisTurn>(inputs, 'round-2-bull-rebuttal');
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'bear', label: 'Conditional: re-challenging (score neutral).' });
      progress('bear', 'Conditional: re-challenging bullish thesis (extra round)...');
      events({ type: 'agent.start', agent: 'bear' });
      const allClaims = [...thesis.claims, ...rebuttal.claims];
      const context = specialistContext({ role: 'BEAR', phase: 'RECHALLENGE', roundNumber: 2, evidence: selection.evidence, bullClaims: allClaims });
      const result = await ctx.bear.challenge(context ? { context } : { ticker, evidenceZone: selection.evidenceZone, bullClaims: allClaims });
      const response: BearChallengeResponse = { ...result.value, messageId: `bear_${runId}_conditional` };
      events({ type: 'agent.text', agent: 'bear', text: response.reasoning });
      assertNotAborted(signal);
      ctx.validator.assertSeenEvidence(response.evidenceIds, selection.evidenceIds);
      await ctx.validator.validateChallenge(response.counterpoints, response.evidenceIds, {
        claimIds: allClaims.map((claim) => claim.claimId), evidenceIds: selection.evidenceIds,
      });
      conditionalBearCounterpoints = response.counterpoints;
      const turn = { response, result } satisfies ChallengeTurn;
      await checkpoint('conditional-bear-rechallenge', turn);
      await ctx.db.conversation.addMessage({
        runId, messageId: `${response.messageId}_conditional`, agent: 'bear', messageType: 'challenge',
        content: challengeContent(response), evidenceIds: response.evidenceIds, sequenceOrder: 5,
        metadata: { challengeCount: response.counterpoints.length, seenEvidenceIds: selection.evidenceIds, conditional: true },
      });
      events({ type: 'agent.complete', agent: 'bear' });
      await record('conditional-bear-rechallenge', result);
      return turn;
    },

    /**
     * Conditional Bull rebuttal. The persisted message id keeps the historical
     * doubled `_conditional` suffix so existing conversation records stay stable.
     */
    'conditional-bull-rebuttal': async (inputs, signal) => {
      const rechallenge = nodeValue<ChallengeTurn>(inputs, 'conditional-bear-rechallenge');
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      events({ type: 'phase', phase: 'bull', label: 'Conditional: responding to re-challenge.' });
      events({ type: 'agent.start', agent: 'bull' });
      progress('bull', 'Conditional: responding to re-challenge...');
      const bullClaims: Claim[] = (await ctx.db.claims.getByRun(runId)).map((claim) => ({
        claimId: claim.claimId,
        statement: claim.statement,
        confidence: claim.confidence,
        reasoning: claim.reasoning ?? 'Persisted validated claim reasoning is unavailable.',
        evidenceIds: claim.evidenceIds,
      }));
      const context = specialistContext({ role: 'BULL', phase: 'REBUTTAL', roundNumber: 2, evidence: selection.evidence, bullClaims, bearCounterpoints: rechallenge.response.counterpoints });
      const result = await ctx.bull.rebuttal(context ? { context } : { ticker, evidenceZone: selection.evidenceZone, bearCounterpoints: rechallenge.response.counterpoints });
      const response: BullAnalysisResponse = { ...result.value, messageId: `bull_rebuttal_${runId}_conditional` };
      emitPublicText(events, 'bull', response.reasoning, 3);
      assertNotAborted(signal);
      ctx.validator.assertSeenEvidence(response.evidenceIds, selection.evidenceIds);
      const validated = await ctx.validator.validate(response.claims, selection.evidenceIds);
      ctx.validator.assertSeenEvidence(validated.flatMap((claim) => claim.evidenceIds), selection.evidenceIds);
      const claims: Claim[] = validated.map((claim, index) => ({ ...claim, claimId: `rebuttal_conditional_${index + 1}` }));
      const messageId = `${response.messageId}_conditional`;
      const turn = { response, claims, result } satisfies ThesisTurn;
      await checkpoint('conditional-bull-rebuttal', turn);
      await ctx.db.conversation.addMessage({
        runId, messageId, agent: 'bull', messageType: 'response', content: response.reasoning,
        evidenceIds: response.evidenceIds, sequenceOrder: 6,
        metadata: { claimCount: claims.length, seenEvidenceIds: selection.evidenceIds, conditional: true },
      });
      for (const claim of claims) await ctx.db.claims.save({ runId, messageId, claim });
      events({ type: 'agent.complete', agent: 'bull' });
      await record('conditional-bull-rebuttal', result);
      return turn;
    },

    /** Conditional verdict: re-weighs every claim and overwrites the round-1 judgment. */
    'resolve-conflicts': async (inputs, signal) => {
      const thesis = nodeValue<ThesisTurn>(inputs, 'round-1-bull-thesis');
      const rebuttal = nodeValue<ThesisTurn>(inputs, 'round-2-bull-rebuttal');
      const conditionalRebuttal = optionalValue<ThesisTurn>(inputs, 'conditional-bull-rebuttal');
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      assertNotAborted(signal);
      events({ type: 'phase', phase: 'judge', label: 'Conditional: re-weighing debate.' });
      events({ type: 'agent.start', agent: 'judge' });
      progress('judge', 'Conditional: re-weighing debate against the rubrik...');
      const allClaims = [...thesis.claims, ...rebuttal.claims, ...(conditionalRebuttal?.claims ?? [])];
      const result = await evaluateArguments({
        claims: allClaims, selection, bullClaims: thesis.claims,
        bearCounterpoints: [...round1BearCounterpoints, ...conditionalBearCounterpoints],
        rebuttalClaims: [...rebuttal.claims, ...(conditionalRebuttal?.claims ?? [])],
        phase: 'RESOLUTION', roundNumber: 2,
      });
      const judgment = result.value;
      events({ type: 'agent.text', agent: 'judge', text: judgment.summary });
      assertNotAborted(signal);
      const turn = { judgment, allClaims, needsExtra: true, result } satisfies JudgeTurn;
      await checkpoint('resolve-conflicts', turn);
      await ctx.db.judgments.save({ runId, judgment });
      await ctx.db.conversation.addMessage({
        runId, messageId: `judge_${runId}_conditional`, agent: 'judge', messageType: 'decision',
        content: judgment.summary, evidenceIds: [], sequenceOrder: 7,
        metadata: { score: judgment.score, stance: judgment.stance, conditional: true, seenEvidenceIds: selection.evidenceIds },
      });
      events({ type: 'agent.complete', agent: 'judge' });
      await record('resolve-conflicts', result);
      return turn;
    },

    /**
     * Evidence release gate. The scope rule is re-derived from the claims the run
     * actually persisted, so no path can persist a citation the run never
     * retrieved, and the in-memory claims are validated once more with the same
     * validator the debate nodes use.
     */
    'check-evidence': async (inputs) => {
      const selection = nodeValue<EvidenceSelection>(inputs, 'select-supporting-evidence');
      const stored = await ctx.db.claims.getByRun(runId);
      ctx.validator.assertSeenEvidence(stored.flatMap((claim) => claim.evidenceIds), selection.evidenceIds);
      const thesisTurns = [
        nodeValue<ThesisTurn>(inputs, 'round-1-bull-thesis'),
        nodeValue<ThesisTurn>(inputs, 'round-2-bull-rebuttal'),
        optionalValue<ThesisTurn>(inputs, 'conditional-bull-rebuttal'),
      ].filter((turn): turn is ThesisTurn => Boolean(turn));
      const challenges = [
        nodeValue<ChallengeTurn>(inputs, 'round-1-bear-challenge'),
        optionalValue<ChallengeTurn>(inputs, 'conditional-bear-rechallenge'),
      ].filter((turn): turn is ChallengeTurn => Boolean(turn));
      const allClaims = thesisTurns.flatMap((turn) => turn.claims);
      ctx.validator.assertSeenEvidence(allClaims.flatMap((claim) => claim.evidenceIds), selection.evidenceIds);
      await ctx.validator.validate(allClaims, selection.evidenceIds);
      for (const challenge of challenges) {
        await ctx.validator.validateChallenge(challenge.response.counterpoints, challenge.response.evidenceIds, {
          claimIds: allClaims.map((claim) => claim.claimId), evidenceIds: selection.evidenceIds,
        });
      }
      return {
        claims: allClaims.length,
        challenges: challenges.reduce((total, turn) => total + turn.response.counterpoints.length, 0),
        evidenceIds: selection.evidenceIds,
      } satisfies EvidenceAudit;
    },

    /**
     * Deterministic gate for the reported verdict: the score must equal the rubric
     * re-derivation and the stance must follow from that score. The model supplies
     * a breakdown, never the arithmetic.
     */
    'synthesize-verdict': async (inputs) => {
      const first = nodeValue<JudgeTurn>(inputs, 'evaluate-arguments');
      const resolved = optionalValue<JudgeTurn>(inputs, 'resolve-conflicts');
      const judgment = (resolved ?? first).judgment;
      const recomputed = normalizeJudgmentScore(judgment.breakdown);
      if (recomputed !== judgment.score) {
        throw new ValidationError(`Judge score ${judgment.score} contradicts the rubric re-derivation ${recomputed}`);
      }
      const stance = stanceForScore(judgment.score);
      if (stance !== judgment.stance) {
        throw new ValidationError(`Judge stance ${judgment.stance} contradicts the deterministic score ${judgment.score} (${stance})`);
      }
      const extraRound = deps.reasoning || (deps.conditional && first.needsExtra);
      return { judgment, rounds: extraRound ? 2 : 1 } satisfies SynthesisTurn;
    },
  };
}
