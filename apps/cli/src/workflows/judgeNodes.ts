import type { BearCounterpoint, BearLLMOutput, BullLLMOutput, Claim, Evidence, Judgment } from '@harness/schemas';
import type { JudgeNodeExecutors, JudgeNodeId, JudgeRoundDecision } from '@harness/command-judge';
import type { SubagentResult } from '@harness/subagent-core';
import { assembleSpecialistContext, type SpecialistContextPacket, type SpecialistPhase, type SpecialistRole } from '@harness/context';
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
  trace?: JudgeNodeTrace;
  lifecycle?: { sessionId: string; turnId: string };
}

export interface CollectedSources {
  evidence: Evidence[];
  evidenceIds: string[];
  marketEvidence: Evidence[];
  newsEvidence: Evidence[];
  marketAvailable: boolean;
  newsAvailable: boolean;
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

  const saveEvidence = async (source: string, data: unknown): Promise<Evidence> => {
    const persisted = await ctx.db.evidence.save({ runId, ticker, source, data: data as Record<string, unknown> });
    events({ type: 'evidence.found', id: persisted.id, source });
    // A deduplicated immutable provider row may retain its original owner run;
    // the runEvidence membership still makes it current execution Evidence.
    return persisted.runId === runId ? persisted : { ...persisted, runId };
  };

  const record = async (nodeId: JudgeNodeId, result: SubagentResult<unknown>): Promise<void> => {
    if (deps.trace) await deps.trace.recordSubagentResult(nodeId, result);
  };
  let round1BearCounterpoints: BearCounterpoint[] = [];
  let conditionalBearCounterpoints: BearCounterpoint[] = [];

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
      const evidence = await saveEvidence(SECTORS_SOURCES.companyReport, report);
      progress('researcher', '✓ Company Report retrieved');
      return evidence;
    },

    /** Quarterly Financials — required ground truth; a failed request ends the run. */
    'fetch-financials': async (_inputs, signal) => {
      const financials = await tool('quarterly_financials', signal, () => ctx.financialData.getQuarterlyFinancials(ticker));
      const evidence = await saveEvidence(SECTORS_SOURCES.quarterlyFinancials, financials);
      progress('researcher', '✓ Quarterly Financials retrieved');
      return evidence;
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
    'collect-sources': async (inputs) => {
      const report = nodeValue<Evidence>(inputs, 'identify-company');
      const financials = nodeValue<Evidence>(inputs, 'fetch-financials');
      const market = optionalValue<{ daily: unknown; foreign: unknown }>(inputs, 'fetch-market-data');
      const news = optionalValue<{ news: unknown; filings: unknown; sentiment: unknown }>(inputs, 'fetch-news');
      const evidenceIds = [report.id, financials.id];
      let marketEvidence: Evidence[] = [];
      let newsEvidence: Evidence[] = [];
      let marketAvailable = false;
      let newsAvailable = false;

      if (market) {
        const daily = await saveEvidence(SECTORS_SOURCES.dailyTransaction, market.daily);
        const foreign = await saveEvidence(SECTORS_SOURCES.foreignFlow, market.foreign);
        marketEvidence = [daily, foreign];
        marketAvailable = true;
        evidenceIds.push(daily.id, foreign.id);
        progress('researcher', '✓ Market data (Daily Transaction + Foreign Flow) retrieved');
      }

      if (news) {
        const item = await saveEvidence(SECTORS_SOURCES.news, news.news);
        const filings = await saveEvidence(SECTORS_SOURCES.filings, news.filings);
        const sentiment = await saveEvidence(SECTORS_SOURCES.sentiment, news.sentiment);
        newsEvidence = [item, filings, sentiment];
        newsAvailable = true;
        evidenceIds.push(item.id, filings.id, sentiment.id);
        progress('researcher', '✓ News / Filings / Sentiment retrieved');
      }

      await ctx.db.conversation.addMessage({
        runId, messageId: `researcher_${runId}`, agent: 'researcher', messageType: 'observation',
        content: `I retrieved the evidence for ${ticker} and stored it for this run.`,
        evidenceIds, sequenceOrder: 0, metadata: { marketAvailable, newsAvailable },
      });
      events({ type: 'agent.text', agent: 'researcher', text: `I identified ${evidenceIds.length} evidence items for ${ticker} and passed them to the debate.` });
      events({ type: 'agent.complete', agent: 'researcher' });
      return {
        evidence: [report, financials, ...marketEvidence, ...newsEvidence],
        evidenceIds, marketEvidence, newsEvidence, marketAvailable, newsAvailable,
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
      await ctx.db.conversation.addMessage({
        runId, messageId: response.messageId, agent: 'bull', messageType: 'claim', content: response.reasoning,
        evidenceIds: response.evidenceIds, sequenceOrder: 1,
        metadata: { claimCount: claims.length, seenEvidenceIds: selection.evidenceIds },
      });
      for (const claim of claims) await ctx.db.claims.save({ runId, messageId: response.messageId, claim });
      events({ type: 'agent.complete', agent: 'bull' });
      progress('bull', `✓ ${claims.length} claim(s) validated and stored`);
      await record('round-1-bull-thesis', result);
      return { response, claims, result } satisfies ThesisTurn;
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
      await ctx.db.conversation.addMessage({
        runId, messageId: response.messageId, agent: 'bear', messageType: 'challenge',
        content: challengeContent(response), evidenceIds: response.evidenceIds, sequenceOrder: 2,
        metadata: { challengeCount: response.counterpoints.length, seenEvidenceIds: selection.evidenceIds },
      });
      events({ type: 'agent.complete', agent: 'bear' });
      progress('bear', `✓ ${response.counterpoints.length} challenge(s) validated`);
      await record('round-1-bear-challenge', result);
      return { response, result } satisfies ChallengeTurn;
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
      await ctx.db.conversation.addMessage({
        runId, messageId: response.messageId, agent: 'bull', messageType: 'response', content: response.reasoning,
        evidenceIds: response.evidenceIds, sequenceOrder: 3,
        metadata: { claimCount: claims.length, seenEvidenceIds: selection.evidenceIds },
      });
      for (const claim of claims) await ctx.db.claims.save({ runId, messageId: response.messageId, claim });
      events({ type: 'agent.complete', agent: 'bull' });
      progress('bull', `✓ ${claims.length} rebuttal claim(s) stored`);
      await record('round-2-bull-rebuttal', result);
      return { response, claims, result } satisfies ThesisTurn;
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
      return { judgment, allClaims, needsExtra: decision.extraRound, result } satisfies JudgeTurn;
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
      await ctx.db.conversation.addMessage({
        runId, messageId: `${response.messageId}_conditional`, agent: 'bear', messageType: 'challenge',
        content: challengeContent(response), evidenceIds: response.evidenceIds, sequenceOrder: 5,
        metadata: { challengeCount: response.counterpoints.length, seenEvidenceIds: selection.evidenceIds, conditional: true },
      });
      events({ type: 'agent.complete', agent: 'bear' });
      await record('conditional-bear-rechallenge', result);
      return { response, result } satisfies ChallengeTurn;
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
      await ctx.db.conversation.addMessage({
        runId, messageId, agent: 'bull', messageType: 'response', content: response.reasoning,
        evidenceIds: response.evidenceIds, sequenceOrder: 6,
        metadata: { claimCount: claims.length, seenEvidenceIds: selection.evidenceIds, conditional: true },
      });
      for (const claim of claims) await ctx.db.claims.save({ runId, messageId, claim });
      events({ type: 'agent.complete', agent: 'bull' });
      await record('conditional-bull-rebuttal', result);
      return { response, claims, result } satisfies ThesisTurn;
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
      await ctx.db.judgments.save({ runId, judgment });
      await ctx.db.conversation.addMessage({
        runId, messageId: `judge_${runId}_conditional`, agent: 'judge', messageType: 'decision',
        content: judgment.summary, evidenceIds: [], sequenceOrder: 7,
        metadata: { score: judgment.score, stance: judgment.stance, conditional: true, seenEvidenceIds: selection.evidenceIds },
      });
      events({ type: 'agent.complete', agent: 'judge' });
      await record('resolve-conflicts', result);
      return { judgment, allClaims, needsExtra: true, result } satisfies JudgeTurn;
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
