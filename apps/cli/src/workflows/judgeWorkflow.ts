import type { BullAnalysisResponse } from '@harness/agent';
import type { ExecutionRun } from '@harness/execution';
import type { Evidence, Judgment } from '@harness/schemas';
import { SectorsApiError, SECTORS_SOURCES } from '@harness/sectors-api';
import { UserFriendlyError, ValidationError } from '@harness/shared';
import type { HarnessContext } from '../context';

/** Hasil lengkap /judge — dipakai renderer output conversational. */
export interface JudgeArtifacts {
  run: ExecutionRun;
  evidence: Evidence[];
  bull: BullAnalysisResponse;
  judgment: Judgment;
}

export type JudgeProgressPhase = 'researcher' | 'bull' | 'judge';
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
 * Workflow /judge — 3-agent flow Phase 0 (addendum §14/Task 14):
 *   Researcher (fetch + simpan evidence) → Bull → validasi → Judge.
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

    // Validasi 3 lapis (struktur / keberadaan evidence / keanggotaan run) — addendum §16
    const claims = await ctx.validator.validate(bull.claims, evidenceIds);

    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: bull.messageId,
      agent: 'bull',
      messageType: 'claim',
      content: bull.reasoning,
      evidenceIds: bull.evidenceIds,
      sequenceOrder: 1,
      metadata: { claimCount: claims.length },
    });
    for (const claim of claims) {
      await ctx.db.claims.save({ runId: run.id, messageId: bull.messageId, claim });
    }
    progress('bull', `✓ ${claims.length} claim(s) validated and stored`);

    // 3. Judge: evaluasi rubrik 5 kategori
    progress('judge', 'Weighing the claims against the rubrik...');
    const conversation = await ctx.db.conversation.getByRun(run.id);
    const judgment = await ctx.judge.evaluate({ ticker, claims, conversation });
    await ctx.db.judgments.save({ runId: run.id, judgment });
    await ctx.db.conversation.addMessage({
      runId: run.id,
      messageId: `judge_${run.id}`,
      agent: 'judge',
      messageType: 'decision',
      content: judgment.summary,
      evidenceIds: [],
      sequenceOrder: 2,
      metadata: { score: judgment.score, stance: judgment.stance },
    });

    const completed = await ctx.db.execution.completeRun(
      run.id,
      (Date.now() - startedAt) / 1000,
    );
    return { run: completed, evidence: [evidenceReport, evidenceFinancials], bull, judgment };
  } catch (error) {
    await ctx.db.execution.failRun(run.id, errorMessage(error)).catch(() => undefined);
    throw toUserFriendly(error, run.id);
  }
}
