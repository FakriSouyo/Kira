import type { BearChallengeResponse, BullAnalysisResponse } from '@harness/agent';
import type { ExecutionRun } from '@harness/execution';
import type { Claim, Evidence, Judgment } from '@harness/schemas';
import { SectorsApiError, SECTORS_SOURCES } from '@harness/sectors-api';
import { UserFriendlyError, ValidationError } from '@harness/shared';
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
): Promise<JudgeArtifacts> {
  const startedAt = Date.now();
  const run = await ctx.db.execution.createRun({ ticker, command: 'judge' });

  try {
    // 1. Researcher fundamental: ambil & simpan evidence (ground truth)
    progress('researcher', `I'm starting with Company Report and Quarterly Financials for ${ticker}...`);
    const report = await ctx.sectors.getCompanyReport(ticker);
    const evidenceReport = await ctx.db.evidence.save({
      runId: run.id,
      ticker,
      source: SECTORS_SOURCES.companyReport,
      data: report as unknown as Record<string, unknown>,
    });
    progress('researcher', '✓ Company Report retrieved');

    const financials = await ctx.sectors.getQuarterlyFinancials(ticker);
    const evidenceFinancials = await ctx.db.evidence.save({
      runId: run.id,
      ticker,
      source: SECTORS_SOURCES.quarterlyFinancials,
      data: financials as unknown as Record<string, unknown>,
    });
    progress('researcher', '✓ Quarterly Financials retrieved');

    const evidenceIds = [evidenceReport.id, evidenceFinancials.id];
    let marketEvidence: Evidence[] = [];
    let newsEvidence: Evidence[] = [];
    let marketAvailable = false;
    let newsAvailable = false;

    // 1b. Researcher Market — enrichment, degrade bila gagal (addendum §24-A.5).
    if (ctx.researchers.market) {
      try {
        const daily = await ctx.sectors.getDailyTransaction(ticker);
        const evDaily = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.dailyTransaction,
          data: daily as unknown as Record<string, unknown>,
        });
        const foreign = await ctx.sectors.getForeignFlow(ticker);
        const evForeign = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.foreignFlow,
          data: foreign as unknown as Record<string, unknown>,
        });
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
        const news = await ctx.sectors.getNews(ticker);
        const evNews = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.news,
          data: news as unknown as Record<string, unknown>,
        });
        const filings = await ctx.sectors.getFilings(ticker);
        const evFilings = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.filings,
          data: filings as unknown as Record<string, unknown>,
        });
        const sentiment = await ctx.sectors.getSentiment(ticker);
        const evSentiment = await ctx.db.evidence.save({
          runId: run.id,
          ticker,
          source: SECTORS_SOURCES.sentiment,
          data: sentiment as unknown as Record<string, unknown>,
        });
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
    progress('judge', 'Weighing the debate against the rubrik...');
    const allClaims = [...bullClaims, ...storedRebuttalClaims];
    const conversation = await ctx.db.conversation.getByRun(run.id);
    const judgment = await ctx.judge.evaluate({ ticker, claims: allClaims, conversation });
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

    const completed = await ctx.db.execution.completeRun(run.id, (Date.now() - startedAt) / 1000);
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
    await ctx.db.execution.failRun(run.id, errorMessage(error)).catch(() => undefined);
    throw toUserFriendly(error, run.id);
  }
}