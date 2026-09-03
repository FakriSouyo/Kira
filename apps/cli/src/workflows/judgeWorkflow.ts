import type { BearChallengeResponse, BullAnalysisResponse } from '@harness/agent';
import type { ExecutionRun } from '@harness/execution';
import type { Claim, Evidence, Judgment } from '@harness/schemas';
import { SectorsApiError, SECTORS_SOURCES } from '@harness/sectors-api';
import { UserFriendlyError, ValidationError } from '@harness/shared';
import type { HarnessContext } from '../context';

/** Hasil lengkap /judge — dipakai renderer output conversational. */
export interface JudgeArtifacts {
  run: ExecutionRun;
  evidence: Evidence[];
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
 * Workflow /judge — flow dengan Debate ronde (addendum §14/Task 14, Phase 1):
 *   Researcher (fetch + simpan evidence)
 *     → Bull (tesis + klaim, tervalidasi 3 lapis)
 *     → Bear (challenge terhadap klaim Bull, tervalidasi run-scoped)
 *     → Bull rebuttal (menjawab challenge, klaim tervalidasi)
 *     → Judge (menimbang semua argumen, rubrik 5 kategori).
 * Agent adalah pure function; seluruh persistence terjadi di sini.
 */
export async function judgeWorkflow(
  ctx: HarnessContext,
  ticker: string,
  progress: JudgeProgress = () => {},
): Promise<JudgeArtifacts> {
  const startedAt = Date.now();
  const run = await ctx.db.execution.createRun({ ticker, command: 'judge' });

  try {
    // 1. Researcher: ambil & simpan evidence (ground truth)
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
    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: `researcher_${run.id}`,
      agent: 'researcher',
      messageType: 'observation',
      content: `I retrieved the Company Report and Quarterly Financials for ${ticker} and stored them as evidence for this run.`,
      evidenceIds,
      sequenceOrder: 0,
    });

    // 2. Bull: analisis → reasoning + klaim terstruktur
    progress('bull', 'Analyzing the evidence for a bullish thesis...');
    const bull = await ctx.bull.analyze({ ticker, evidenceIds });
    const bullClaims = await ctx.validator.validate(bull.claims, evidenceIds);

    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: bull.messageId,
      agent: 'bull',
      messageType: 'claim',
      content: bull.reasoning,
      evidenceIds: bull.evidenceIds,
      sequenceOrder: 1,
      metadata: { claimCount: bullClaims.length },
    });
    for (const claim of bullClaims) {
      await ctx.db.claims.save({ runId: run.id, messageId: bull.messageId, claim });
    }
    progress('bull', `✓ ${bullClaims.length} claim(s) validated and stored`);

    // 3. Bear: challenge terhadap klaim Bull (Debate ronde, addendum §15)
    progress('bear', 'Challenging the bullish thesis...');
    const bear = await ctx.bear.challenge({ ticker, evidenceIds, bullClaims });
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
      metadata: { challengeCount: bear.counterpoints.length },
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
      metadata: { claimCount: storedRebuttalClaims.length },
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

    const completed = await ctx.db.execution.completeRun(
      run.id,
      (Date.now() - startedAt) / 1000,
    );
    return {
      run: completed,
      evidence: [evidenceReport, evidenceFinancials],
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
