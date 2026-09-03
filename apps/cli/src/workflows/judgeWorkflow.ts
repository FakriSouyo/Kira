import type { BearChallengeResponse, BullAnalysisResponse } from '@harness/agent';
import type { ExecutionRun } from '@harness/execution';
import type { Claim, Evidence, Judgment } from '@harness/schemas';
import { SectorsApiError, SECTORS_SOURCES } from '@harness/sectors-api';
import { UserFriendlyError, ValidationError } from '@harness/shared';
import type { AgentEvent, AgentToolName } from '../repl/events';
import type { HarnessContext } from '../context';

/** Hasil lengkap /judge — dipakai renderer output conversational. */
export interface JudgeArtifacts {
  run: ExecutionRun;
  /** Evidence fundamental (Company Report + Quarterly Financials). */
  evidence: Evidence[];
  /** Evidence Market (Daily Transaction + Foreign Flow) — enrichment (addendum §24-A). */
  marketEvidence: Evidence[];
  /** Evidence News (News + Filings + Sentiment) — enrichment (addendum §24-A). */
  newsEvidence: Evidence[];
  /** Market tersedia → `marketMomentum` dapat dinilai (false = degrade → null). */
  marketAvailable: boolean;
  /** News tersedia → `risk` dapat dinilai (false = degrade → null). */
  newsAvailable: boolean;
  bull: BullAnalysisResponse;
  bear: BearChallengeResponse;
  rebuttal: BullAnalysisResponse;
  judgment: Judgment;
}

export type JudgeProgressPhase = 'researcher' | 'bull' | 'bear' | 'judge';
export type JudgeProgress = (phase: JudgeProgressPhase, line: string) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toUserFriendly(error: unknown, runId: string): UserFriendlyError {
  if (error instanceof UserFriendlyError) return error;
  if (error instanceof SectorsApiError) {
    return new UserFriendlyError(error.code, error.message, error.suggestion);
  }
  if (error instanceof ValidationError) {
    return new UserFriendlyError(
      'EVIDENCE_HALLUCINATION',
      error.message,
      `Run-scoped validation gagal pada run ${runId} — laporkan dengan run id ini.`,
    );
  }
  return new UserFriendlyError(
    'UNKNOWN_ERROR',
    errorMessage(error),
    `Cek output di atas atau coba lagi. Run id: ${runId}`,
  );
}

/**
 * Workflow /judge — flow dengan Debate ronde + Market/News Researcher
 * (addendum §14/§24-A, Phase 1):
 *   Researcher fundamental → Researcher Market → Researcher News
 *     → Bull (tesis + klaim) → Bear (challenge) → Bull rebuttal
 *     → Judge (menimbang seluruh debat, rubrik 5 kategori).
 * Agent adalah pure function; seluruh persistence & degradasi terjadi di sini.
 *
 * Degradasi enrichment (addendum §24-A.5): kegagalan Market/News → kategori
 * rubrik terkait `null`, run tetap `completed`. Kegagalan fundamental
 * (Company Report/Financials) → run `failed`.
 */
export async function judgeWorkflow(
  ctx: HarnessContext,
  ticker: string,
  progress: JudgeProgress = () => {},
  events: (event: AgentEvent) => void = () => {},
  opts: { conditional?: boolean } = {},
): Promise<JudgeArtifacts> {
  // Emit satu tool fetch (start + duration) — dipakai Agent-Events TUI (Task 2).
  const tool = async <T>(name: AgentToolName, fetcher: () => Promise<T>): Promise<T> => {
    events({ type: 'tool.start', tool: name, ticker });
    const started = Date.now();
    try {
      return await fetcher();
    } finally {
      events({ type: 'tool.complete', tool: name, durationMs: Date.now() - started });
    }
  };
  const startedAt = Date.now();
  const run = await ctx.db.execution.createRun({ ticker, command: 'judge' });
  events({ type: 'session.start', runId: run.id });

  try {
    // 1. Researcher fundamental: ambil & simpan evidence (ground truth)
    events({ type: 'phase', phase: 'researcher', label: "I'm starting with Company Report and Quarterly Financials." });
    progress('researcher', `I'm starting with Company Report and Quarterly Financials for ${ticker}...`);
    const report = await tool('company_report', () => ctx.sectors.getCompanyReport(ticker));
    const evidenceReport = await ctx.db.evidence.save({
      runId: run.id,
      ticker,
      source: SECTORS_SOURCES.companyReport,
      data: report as unknown as Record<string, unknown>,
    });
    events({ type: 'evidence.found', id: evidenceReport.id, source: SECTORS_SOURCES.companyReport });
    progress('researcher', '✓ Company Report retrieved');

    const financials = await tool('quarterly_financials', () => ctx.sectors.getQuarterlyFinancials(ticker));
    const evidenceFinancials = await ctx.db.evidence.save({
      runId: run.id,
      ticker,
      source: SECTORS_SOURCES.quarterlyFinancials,
      data: financials as unknown as Record<string, unknown>,
    });
    events({ type: 'evidence.found', id: evidenceFinancials.id, source: SECTORS_SOURCES.quarterlyFinancials });
    progress('researcher', '✓ Quarterly Financials retrieved');

    const evidenceIds = [evidenceReport.id, evidenceFinancials.id];
    let marketEvidence: Evidence[] = [];
    let newsEvidence: Evidence[] = [];
    let marketAvailable = false;
    let newsAvailable = false;

    // 1b. Researcher Market — enrichment, degrade bila gagal (addendum §24-A.5).
    if (ctx.researchers.market) {
      try {
        const daily = await tool('daily_transaction', () => ctx.sectors.getDailyTransaction(ticker));
        const evDaily = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.dailyTransaction,
          data: daily as unknown as Record<string, unknown>,
        });
        events({ type: 'evidence.found', id: evDaily.id, source: SECTORS_SOURCES.dailyTransaction });
        const foreign = await tool('foreign_flow', () => ctx.sectors.getForeignFlow(ticker));
        const evForeign = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.foreignFlow,
          data: foreign as unknown as Record<string, unknown>,
        });
        events({ type: 'evidence.found', id: evForeign.id, source: SECTORS_SOURCES.foreignFlow });
        marketEvidence = [evDaily, evForeign];
        marketAvailable = true;
        evidenceIds.push(evDaily.id, evForeign.id);
        progress('researcher', '✓ Market data (Daily Transaction + Foreign Flow) retrieved');
      } catch {
        progress('researcher', '⚠ Market data unavailable — marketMomentum left unevaluated');
      }
    }

    // 1c. Researcher News — enrichment, degrade bila gagal (addendum §24-A.5).
    if (ctx.researchers.news) {
      try {
        const news = await tool('news', () => ctx.sectors.getNews(ticker));
        const evNews = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.news,
          data: news as unknown as Record<string, unknown>,
        });
        events({ type: 'evidence.found', id: evNews.id, source: SECTORS_SOURCES.news });
        const filings = await tool('filings', () => ctx.sectors.getFilings(ticker));
        const evFilings = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.filings,
          data: filings as unknown as Record<string, unknown>,
        });
        events({ type: 'evidence.found', id: evFilings.id, source: SECTORS_SOURCES.filings });
        const sentiment = await tool('sentiment', () => ctx.sectors.getSentiment(ticker));
        const evSentiment = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.sentiment,
          data: sentiment as unknown as Record<string, unknown>,
        });
        events({ type: 'evidence.found', id: evSentiment.id, source: SECTORS_SOURCES.sentiment });
        newsEvidence = [evNews, evFilings, evSentiment];
        newsAvailable = true;
        evidenceIds.push(evNews.id, evFilings.id, evSentiment.id);
        progress('researcher', '✓ News / Filings / Sentiment retrieved');
      } catch {
        progress('researcher', '⚠ News data unavailable — risk left unevaluated');
      }
    }

    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: `researcher_${run.id}`,
      agent: 'researcher',
      messageType: 'observation',
      content: `I retrieved the evidence for ${ticker} and stored it for this run.`,
      evidenceIds,
      sequenceOrder: 0,
      metadata: { marketAvailable, newsAvailable },
    });

    // 2. Bull: analisis → reasoning + klaim terstruktur (semua evidence dilihat)
    events({ type: 'phase', phase: 'bull', label: 'Analyzing the evidence for a bullish thesis.' });
    progress('bull', 'Analyzing the evidence for a bullish thesis...');
    const bull = await ctx.bull.analyze({ ticker, evidenceIds });
    const bullClaims = await ctx.validator.validate(bull.claims, evidenceIds);
    // Invariant §24-B.1: klaim hanya boleh merujuk evidence yang benar-benar dilihat.
    ctx.validator.assertSeenEvidence(
      bullClaims.flatMap((c) => c.evidenceIds),
      evidenceIds,
    );

    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: bull.messageId,
      agent: 'bull',
      messageType: 'claim',
      content: bull.reasoning,
      evidenceIds: bull.evidenceIds,
      sequenceOrder: 1,
      metadata: { claimCount: bullClaims.length, seenEvidenceIds: evidenceIds },
    });
    for (const claim of bullClaims) {
      await ctx.db.claims.save({ runId: run.id, messageId: bull.messageId, claim });
    }
    progress('bull', `✓ ${bullClaims.length} claim(s) validated and stored`);

    // 3. Bear: challenge terhadap klaim Bull (Debate ronde, addendum §15)
    events({ type: 'phase', phase: 'bear', label: 'Challenging the bullish thesis.' });
    progress('bear', 'Challenging the bullish thesis...');
    const bear = await ctx.bear.challenge({ ticker, evidenceIds, bullClaims });
    ctx.validator.assertSeenEvidence(bear.evidenceIds, evidenceIds);
    await ctx.validator.validateChallenge(
      bear.counterpoints,
      bear.evidenceIds,
      { claimIds: bullClaims.map((c) => c.claimId), evidenceIds },
    );
    const bearContent =
      bear.reasoning +
      '\n' +
      bear.counterpoints
        .map((cp, i) => `Challenge #${i + 1} (targets claim ${cp.targetClaimId}, strength ${cp.strength}): ${cp.argument}`)
        .join('\n');
    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: bear.messageId,
      agent: 'bear',
      messageType: 'challenge',
      content: bearContent,
      evidenceIds: bear.evidenceIds,
      sequenceOrder: 2,
      metadata: { challengeCount: bear.counterpoints.length, seenEvidenceIds: evidenceIds },
    });
    progress('bear', `✓ ${bear.counterpoints.length} challenge(s) validated`);

    // 4. Bull rebuttal: menjawab challenge Bear
    events({ type: 'phase', phase: 'bull', label: 'Responding to the challenges.' });
    progress('bull', 'Responding to the challenges...');
    const rebuttal = await ctx.bull.rebuttal({
      ticker,
      evidenceIds,
      bearCounterpoints: bear.counterpoints,
    });
    const rebuttalClaims = await ctx.validator.validate(rebuttal.claims, evidenceIds);
    ctx.validator.assertSeenEvidence(
      rebuttalClaims.flatMap((c) => c.evidenceIds),
      evidenceIds,
    );
    // Normalisasi claimId rebuttal — UNIQUE(run_id, claim_id) di DB; id
    // `rebuttal_N` juga menandai asal claim di audit trail.
    const storedRebuttalClaims: Claim[] = rebuttalClaims.map((c, i) => ({ ...c, claimId: `rebuttal_${i + 1}` }));
    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: rebuttal.messageId,
      agent: 'bull',
      messageType: 'response',
      content: rebuttal.reasoning,
      evidenceIds: rebuttal.evidenceIds,
      sequenceOrder: 3,
      metadata: { claimCount: storedRebuttalClaims.length, seenEvidenceIds: evidenceIds },
    });
    for (const claim of storedRebuttalClaims) {
      await ctx.db.claims.save({ runId: run.id, messageId: rebuttal.messageId, claim });
    }
    progress('bull', `✓ ${storedRebuttalClaims.length} rebuttal claim(s) stored`);

    // 5. Judge: menimbang semua argumen (klaim Bull + rebuttal) terhadap rubrik
    events({ type: 'phase', phase: 'judge', label: 'Weighing the debate against the rubrik.' });
    progress('judge', 'Weighing the debate against the rubrik...');
    const allClaims = [...bullClaims, ...storedRebuttalClaims];
    const conversation = await ctx.db.conversation.getByRun(run.id);
    let judgment = await ctx.judge.evaluate({ ticker, claims: allClaims, conversation });
    await ctx.db.judgments.save({ runId: run.id, judgment });
    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: `judge_${run.id}`,
      agent: 'judge',
      messageType: 'decision',
      content: judgment.summary,
      evidenceIds: [],
      sequenceOrder: 4,
      metadata: { score: judgment.score, stance: judgment.stance },
    });

    // 5b. Conditional debate — satu ronde ekstra bila neutral / 40–60 (Phase 3)
    const needsExtra = opts.conditional && (judgment.stance === 'neutral' || (judgment.score >= 40 && judgment.score <= 60));
    if (needsExtra) {
      events({ type: 'phase', phase: 'bear', label: 'Conditional: re-challenging (score neutral).' });
      progress('bear', 'Conditional: re-challenging bullish thesis (extra round)...');
      const bear2 = await ctx.bear.challenge({ ticker, evidenceIds, bullClaims: [...bullClaims, ...storedRebuttalClaims] });
      ctx.validator.assertSeenEvidence(bear2.evidenceIds, evidenceIds);
      await ctx.validator.validateChallenge(
        bear2.counterpoints,
        bear2.evidenceIds,
        { claimIds: [...bullClaims, ...storedRebuttalClaims].map((c) => c.claimId), evidenceIds },
      );
      const bear2Content =
        bear2.reasoning +
        '\n' +
        bear2.counterpoints
          .map((cp, i) => `Challenge #${i + 1} (targets claim ${cp.targetClaimId}, strength ${cp.strength}): ${cp.argument}`)
          .join('\n');
      await ctx.db.conversation.addMessage({
        runId: run.id,
        messageId: `${bear2.messageId}_conditional`,
        agent: 'bear',
        messageType: 'challenge',
        content: bear2Content,
        evidenceIds: bear2.evidenceIds,
        sequenceOrder: 5,
        metadata: { challengeCount: bear2.counterpoints.length, seenEvidenceIds: evidenceIds, conditional: true },
      });

      events({ type: 'phase', phase: 'bull', label: 'Conditional: responding to re-challenge.' });
      progress('bull', 'Conditional: responding to re-challenge...');
      const rebuttal2 = await ctx.bull.rebuttal({
        ticker,
        evidenceIds,
        bearCounterpoints: bear2.counterpoints,
      });
      const rebuttal2Claims = await ctx.validator.validate(rebuttal2.claims, evidenceIds);
      ctx.validator.assertSeenEvidence(
        rebuttal2Claims.flatMap((c) => c.evidenceIds),
        evidenceIds,
      );
      const storedRebuttal2Claims: Claim[] = rebuttal2Claims.map((c, i) => ({ ...c, claimId: `rebuttal_conditional_${i + 1}` }));
      await ctx.db.conversation.addMessage({
        runId: run.id,
        messageId: `${rebuttal2.messageId}_conditional`,
        agent: 'bull',
        messageType: 'response',
        content: rebuttal2.reasoning,
        evidenceIds: rebuttal2.evidenceIds,
        sequenceOrder: 6,
        metadata: { claimCount: storedRebuttal2Claims.length, seenEvidenceIds: evidenceIds, conditional: true },
      });
      for (const claim of storedRebuttal2Claims) {
        await ctx.db.claims.save({ runId: run.id, messageId: `${rebuttal2.messageId}_conditional`, claim });
      }

      // Re-evaluate judge dengan semua klaim (overwrite judgment via upsert)
      events({ type: 'phase', phase: 'judge', label: 'Conditional: re-weighing debate.' });
      progress('judge', 'Conditional: re-weighing debate against the rubrik...');
      const allClaims2 = [...bullClaims, ...storedRebuttalClaims, ...storedRebuttal2Claims];
      const conversation2 = await ctx.db.conversation.getByRun(run.id);
      judgment = await ctx.judge.evaluate({ ticker, claims: allClaims2, conversation: conversation2 });
      await ctx.db.judgments.save({ runId: run.id, judgment });
      await ctx.db.conversation.addMessage({
        runId: run.id,
        messageId: `judge_${run.id}_conditional`,
        agent: 'judge',
        messageType: 'decision',
        content: judgment.summary,
        evidenceIds: [],
        sequenceOrder: 7,
        metadata: { score: judgment.score, stance: judgment.stance, conditional: true },
      });
    }

    const completed = await ctx.db.execution.completeRun(run.id, (Date.now() - startedAt) / 1000);
    events({ type: 'session.complete', runId: run.id, status: 'completed' });
    return {
      run: completed,
      evidence: [evidenceReport, evidenceFinancials],
      marketEvidence,
      newsEvidence,
      marketAvailable,
      newsAvailable,
      bull,
      bear,
      rebuttal,
      judgment,
    };
  } catch (error) {
    events({ type: 'session.complete', runId: run.id, status: 'failed' });
    await ctx.db.execution.failRun(run.id, errorMessage(error)).catch(() => undefined);
    throw toUserFriendly(error, run.id);
  }
}