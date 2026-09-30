import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyFinancialObservation } from '@harness/financial-data';
import { createFinancialEvidenceCandidate, decideEvidenceCandidate } from '@harness/evidence';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { ComparisonMatrix } from '@harness/schemas';
import type { ComparisonReportPublicationStore } from '@harness/session-core';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

const TICKER_IDS = {
  BBCA: '11111111-1111-4111-8111-111111111111',
  BBRI: '22222222-2222-4222-8222-222222222222',
  BMRI: '33333333-3333-4333-8333-333333333333',
} as const;

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-comparison-report-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  if (db.raw.open) db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createExecution(id: string, ticker = 'BBCA', command = 'compare') {
  const session = await db.sessions.createSession({ sessionId: `session_${id}`, title: 'Comparison report test', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
  const turn = await db.sessions.createTurn({ sessionId: session.id, turnId: `turn_${id}`, input: 'Compare these companies.', command });
  const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: id, ticker, command });
  return { session, turn, execution };
}

async function acceptQuarterlyEvidence(executionId: string, ticker: keyof typeof TICKER_IDS) {
  const source = 'sectors.quarterly_financials';
  const data = { ticker, quarters: [{ period: '2026-Q2', revenue: 100, netIncome: 10 }] };
  const observation = verifyFinancialObservation('quarterly_financials', { data, metadata: {
    providerId: 'sectors', source, origin: 'MOCK', fetchedAt: null,
    dataAsOf: null, requestedAsOf: null, period: '2026-Q2', derivedFrom: [],
  } }, ticker);
  const decision = decideEvidenceCandidate(createFinancialEvidenceCandidate({ executionId, ticker, observation }), '2026-09-30T00:00:00.000Z');
  if (!decision.accepted) throw new Error('test candidate should be accepted');
  return db.evidence.accept({ runId: executionId, ticker, source: decision.source, data: decision.data, acceptance: decision });
}

function payload(tickers: readonly (keyof typeof TICKER_IDS)[], ids: Partial<Record<keyof typeof TICKER_IDS, string>> = {}): ComparisonMatrix {
  const values = Object.fromEntries(tickers.map((ticker, index) => [ticker, (tickers.length - index) * 5])) as Record<string, number>;
  const source = (ticker: keyof typeof TICKER_IDS, metric: string) => ({
    evidenceId: ids[ticker] ?? TICKER_IDS[ticker], path: `quarters[2026-Q2].${metric}`, periodLabel: '2026-Q2',
  });
  const subjects = tickers.map(ticker => ({ ticker }));
  const metrics = [
    {
      metric: 'revenueGrowthYoy', unit: 'percent', status: 'comparable',
      cells: tickers.map(ticker => ({ ticker, status: 'available', value: values[ticker]!, unit: 'percent', source: source(ticker, 'revenueGrowthYoy') })),
    },
    {
      metric: 'netIncomeGrowthYoy', unit: 'percent', status: 'unavailable',
      cells: tickers.map(ticker => ({ ticker, status: 'unavailable', reason: 'VALUE_MISSING', unit: 'percent', source: source(ticker, 'netIncomeGrowthYoy') })),
    },
  ];
  const differences = tickers.flatMap((leftTicker, leftIndex) => tickers.slice(leftIndex + 1).map(rightTicker => ({
    metric: 'revenueGrowthYoy', leftTicker, rightTicker, value: values[leftTicker]! - values[rightTicker]!,
    unit: 'percentage_points', left: source(leftTicker, 'revenueGrowthYoy'), right: source(rightTicker, 'revenueGrowthYoy'),
  })));
  return { subjects, selectedPeriod: '2026-Q2', metrics, differences, warnings: [] } as unknown as ComparisonMatrix;
}

function publicationStore(): ComparisonReportPublicationStore {
  return db.comparisonReportPublication;
}

describe('ComparisonReportPublicationStore', () => {
  it('exposes the narrow Session-core publication port from the database client', () => {
    expect(publicationStore()).toBeDefined();
  });

  it('rejects a matrix whose first subject does not match the Execution anchor ticker', async () => {
    const owner = await createExecution('run_compare_anchor_mismatch', 'BBCA');
    const store = publicationStore();
    expect(store).toBeDefined();
    if (!store) return;

    await expect(store.completeAndPublish({ executionId: owner.execution.id, payload: payload(['BBRI', 'BBCA']), executionTimeSeconds: 1 }))
      .rejects.toThrow(/anchor|first subject|ticker/i);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]).toMatchObject({ status: 'running', completedAt: null });
  });

  it('rejects an Evidence reference accepted by a different Execution', async () => {
    const owner = await createExecution('run_compare_foreign_evidence');
    const foreign = await createExecution('run_compare_foreign_source', 'BBRI');
    const ownerEvidence = await acceptQuarterlyEvidence(owner.execution.id, 'BBCA');
    const evidence = await acceptQuarterlyEvidence(foreign.execution.id, 'BBRI');
    const store = publicationStore();
    expect(store).toBeDefined();
    if (!store) return;

    await expect(store.completeAndPublish({
      executionId: owner.execution.id, payload: payload(['BBCA', 'BBRI'], { BBCA: ownerEvidence.id, BBRI: evidence.id }), executionTimeSeconds: 1,
    })).rejects.toThrow(/has no membership/i);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]?.status).toBe('running');
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
  });

  it('rolls back Execution completion when durable report insertion fails', async () => {
    const owner = await createExecution('run_compare_rollback');
    const ids: Partial<Record<keyof typeof TICKER_IDS, string>> = {
      BBCA: (await acceptQuarterlyEvidence(owner.execution.id, 'BBCA')).id,
      BBRI: (await acceptQuarterlyEvidence(owner.execution.id, 'BBRI')).id,
    };
    db.raw.exec(`CREATE TRIGGER reject_comparison_report BEFORE INSERT ON artifacts
      WHEN NEW.kind = 'COMPARISON_REPORT' BEGIN SELECT RAISE(ABORT, 'forced comparison publication failure'); END;`);
    const store = publicationStore();
    expect(store).toBeDefined();
    if (!store) return;

    await expect(store.completeAndPublish({ executionId: owner.execution.id, payload: payload(['BBCA', 'BBRI'], ids), executionTimeSeconds: 3 }))
      .rejects.toThrow(/forced comparison publication failure/);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]).toMatchObject({ status: 'running', completedAt: null });
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
  });

  it('completes a two-subject compare, persists one matrix, and returns the exact durable retry', async () => {
    const owner = await createExecution('run_compare_happy_path');
    const ids: Partial<Record<keyof typeof TICKER_IDS, string>> = {
      BBCA: (await acceptQuarterlyEvidence(owner.execution.id, 'BBCA')).id,
      BBRI: (await acceptQuarterlyEvidence(owner.execution.id, 'BBRI')).id,
    };
    const input = payload(['BBCA', 'BBRI'], ids);
    const first = await publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: input, executionTimeSeconds: 2.5 });

    expect(first).toMatchObject({
      execution: { id: owner.execution.id, status: 'completed', command: 'compare', executionTime: 2.5, error: null },
      artifact: {
        artifactId: `artifact_comparison_report_${owner.execution.id}`, kind: 'COMPARISON_REPORT', schemaVersion: 1,
        sessionId: owner.session.id, turnId: owner.turn.id, executionId: owner.execution.id, ticker: 'BBCA', payload: input,
      },
    });
    expect(first.execution.completedAt).toBe(first.artifact.createdAt);
    expect(first.artifact.payload.metrics.map(metric => metric.status)).toEqual(['comparable', 'unavailable']);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).session.updatedAt).toBe(first.execution.completedAt);
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([first.artifact]);

    db.raw.close();
    db = openDb({ homeDir: dir });
    expect(await db.sessions.getSessionArtifacts(owner.session.id)).toMatchObject({ executions: [first.execution] });
    expect(await db.artifacts.getById(first.artifact.artifactId)).toEqual(first.artifact);
    expect(await publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: input, executionTimeSeconds: 99 })).toEqual(first);

    const changed = structuredClone(input) as ComparisonMatrix & { subjects: Array<{ ticker: string; name?: string }> };
    changed.subjects[0] = { ...changed.subjects[0]!, name: 'A different durable identity' };
    await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: changed, executionTimeSeconds: 2.5 }))
      .rejects.toThrow(/conflict|immutable/i);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE execution_id = ?').get(owner.execution.id)).toEqual({ count: 1 });
  });

  it('publishes a three-subject matrix and does not require unavailable cells to have separate Evidence', async () => {
    const owner = await createExecution('run_compare_three_subjects');
    const ids: Partial<Record<keyof typeof TICKER_IDS, string>> = {
      BBCA: (await acceptQuarterlyEvidence(owner.execution.id, 'BBCA')).id,
      BBRI: (await acceptQuarterlyEvidence(owner.execution.id, 'BBRI')).id,
      BMRI: (await acceptQuarterlyEvidence(owner.execution.id, 'BMRI')).id,
    };
    const input = payload(['BBCA', 'BBRI', 'BMRI'], ids);
    const published = await publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: input, executionTimeSeconds: 0 });

    expect(published.artifact.payload.subjects.map(subject => subject.ticker)).toEqual(['BBCA', 'BBRI', 'BMRI']);
    expect(published.artifact.payload.differences).toHaveLength(3);
    expect(published.artifact.payload.metrics[1]?.status).toBe('unavailable');
  });

  it('rejects a command mismatch, noncanonical lifecycle link, malformed matrix, or invalid time', async () => {
    const research = await createExecution('run_compare_wrong_command', 'BBCA', 'research');
    await expect(publicationStore().completeAndPublish({ executionId: research.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 }))
      .rejects.toThrow(/compare execution|command/i);

    const owner = await createExecution('run_compare_wrong_turn_session');
    const otherSession = await db.sessions.createSession({ sessionId: 'session_compare_other_link', title: 'Other compare session', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const otherTurn = await db.sessions.createTurn({ sessionId: otherSession.id, turnId: 'turn_compare_other_link', input: 'Compare BMRI.', command: 'compare' });
    db.raw.prepare('UPDATE executions SET turn_id = ? WHERE id = ?').run(otherTurn.id, owner.execution.id);
    await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 }))
      .rejects.toThrow(/canonical Session\/Turn links/);

    const malformed = await createExecution('run_compare_bad_matrix');
    await expect(publicationStore().completeAndPublish({
      executionId: malformed.execution.id, payload: { ...payload(['BBCA', 'BBRI']), differences: [] }, executionTimeSeconds: 1,
    })).rejects.toThrow();
    expect((await db.sessions.getSessionArtifacts(malformed.session.id)).executions[0]?.status).toBe('running');

    const invalidTimes = [Number.NaN, Number.POSITIVE_INFINITY, -1];
    for (const [index, executionTimeSeconds] of invalidTimes.entries()) {
      const timed = await createExecution(`run_compare_bad_time_${index}`);
      await expect(publicationStore().completeAndPublish({ executionId: timed.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds }))
        .rejects.toThrow(/finite non-negative/);
      expect((await db.sessions.getSessionArtifacts(timed.session.id)).executions[0]?.status).toBe('running');
    }
  });

  it('rejects legacy, corrupt, nonfinancial, invalid-date, temporal, and wrong-kind memberships', async () => {
    const cases = [
      { name: 'legacy', mutate: async (executionId: string) => insertLegacyEvidenceFixture(db.raw, { runId: executionId, ticker: 'BBCA', source: 'legacy.comparison', data: { ticker: 'BBCA' } }) },
      { name: 'corrupt-policy', mutate: async (executionId: string) => {
        const current = await acceptQuarterlyEvidence(executionId, 'BBCA');
        db.raw.prepare('UPDATE run_evidence SET policy_fingerprint = ? WHERE run_id = ? AND evidence_id = ?').run('0'.repeat(64), executionId, current.id);
        return current;
      } },
      { name: 'nonfinancial', mutate: async (executionId: string) => {
        const current = await acceptQuarterlyEvidence(executionId, 'BBCA');
        db.raw.prepare('UPDATE run_evidence SET candidate_kind = ? WHERE run_id = ? AND evidence_id = ?').run('document', executionId, current.id);
        return current;
      } },
      { name: 'invalid-accepted-at', mutate: async (executionId: string) => {
        const current = await acceptQuarterlyEvidence(executionId, 'BBCA');
        db.raw.prepare('UPDATE run_evidence SET accepted_at = ? WHERE run_id = ? AND evidence_id = ?').run('not-a-date', executionId, current.id);
        return current;
      } },
      { name: 'temporal-valid-at', mutate: async (executionId: string) => {
        const current = await acceptQuarterlyEvidence(executionId, 'BBCA');
        db.raw.prepare('UPDATE run_evidence SET valid_at = ? WHERE run_id = ? AND evidence_id = ?').run('2026-09-30T00:00:00.000Z', executionId, current.id);
        return current;
      } },
      { name: 'wrong-kind', mutate: async (executionId: string) => {
        const current = await acceptQuarterlyEvidence(executionId, 'BBCA');
        const raw = db.raw.prepare('SELECT provenance_json AS provenanceJson FROM run_evidence WHERE run_id = ? AND evidence_id = ?').get(executionId, current.id) as { provenanceJson: string };
        const provenance = JSON.parse(raw.provenanceJson) as Record<string, unknown>;
        db.raw.prepare('UPDATE run_evidence SET provenance_json = ? WHERE run_id = ? AND evidence_id = ?')
          .run(JSON.stringify({ ...provenance, observationKind: 'company_report' }), executionId, current.id);
        return current;
      } },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const owner = await createExecution(`run_compare_acceptance_${index}`);
      const evidence = await item.mutate(owner.execution.id);
      const acceptedOther = await acceptQuarterlyEvidence(owner.execution.id, 'BBRI');
      await expect(publicationStore().completeAndPublish({
        executionId: owner.execution.id,
        payload: payload(['BBCA', 'BBRI'], { BBCA: evidence.id, BBRI: acceptedOther.id }), executionTimeSeconds: 1,
      }), item.name).rejects.toThrow(/legacy|current|acceptance|acceptedAt|validAt|quarterly_financials/i);
      expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]?.status).toBe('running');
      expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
    }
  });

  it('rejects missing membership, a matrix-to-Evidence ticker mismatch, and one ID assigned to two subjects', async () => {
    const missing = await createExecution('run_compare_missing_evidence');
    await expect(publicationStore().completeAndPublish({ executionId: missing.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 }))
      .rejects.toThrow(/Evidence not found/i);

    const wrongTicker = await createExecution('run_compare_wrong_evidence_ticker');
    const bbcaEvidence = await acceptQuarterlyEvidence(wrongTicker.execution.id, 'BBCA');
    const bbriEvidence = await acceptQuarterlyEvidence(wrongTicker.execution.id, 'BBRI');
    await expect(publicationStore().completeAndPublish({
      executionId: wrongTicker.execution.id, payload: payload(['BBCA', 'BBRI'], { BBCA: bbriEvidence.id, BBRI: bbcaEvidence.id }), executionTimeSeconds: 1,
    })).rejects.toThrow(/ticker does not match/i);

    const shared = await createExecution('run_compare_evidence_reused');
    const oneEvidence = await acceptQuarterlyEvidence(shared.execution.id, 'BBCA');
    await expect(publicationStore().completeAndPublish({
      executionId: shared.execution.id, payload: payload(['BBCA', 'BBRI'], { BBCA: oneEvidence.id, BBRI: oneEvidence.id }), executionTimeSeconds: 1,
    })).rejects.toThrow(/multiple subjects/i);
    expect((await db.sessions.getSessionArtifacts(shared.session.id)).executions[0]?.status).toBe('running');
  });

  it('rejects non-running states and a completed Execution missing its Comparison Report', async () => {
    const failed = await createExecution('run_compare_failed');
    await db.sessions.settleExecution(failed.execution.id, 'failed', { error: 'failed' });
    await expect(publicationStore().completeAndPublish({ executionId: failed.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 })).rejects.toThrow(/failed|terminal|no further/i);

    const cancelled = await createExecution('run_compare_cancelled');
    await db.sessions.settleExecution(cancelled.execution.id, 'cancelled');
    await expect(publicationStore().completeAndPublish({ executionId: cancelled.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 })).rejects.toThrow(/cancelled|terminal|no further/i);

    const interrupted = await createExecution('run_compare_interrupted');
    await db.sessions.interruptExecution(interrupted.execution.id);
    await expect(publicationStore().completeAndPublish({ executionId: interrupted.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 })).rejects.toThrow(/interrupted|terminal|no further/i);

    const impossible = await createExecution('run_compare_completed_missing_report');
    await db.sessions.settleExecution(impossible.execution.id, 'completed');
    await expect(publicationStore().completeAndPublish({ executionId: impossible.execution.id, payload: payload(['BBCA', 'BBRI']), executionTimeSeconds: 1 })).rejects.toThrow(/missing.*Comparison Report/i);
  });

  it('rejects Comparison Reports through the generic ArtifactStore write path', async () => {
    const owner = await createExecution('run_compare_generic_artifact_write');
    await db.sessions.settleExecution(owner.execution.id, 'completed');
    const report = {
      artifactId: `artifact_comparison_report_${owner.execution.id}`, kind: 'COMPARISON_REPORT', schemaVersion: 1,
      sessionId: owner.session.id, turnId: owner.turn.id, executionId: owner.execution.id, ticker: 'BBCA',
      payload: payload(['BBCA', 'BBRI']), createdAt: '2026-09-30T00:00:00.000Z',
    } as never;

    await expect(db.artifacts.save(report)).rejects.toThrow(/COMPARISON_REPORT must be published through the Comparison Report publication boundary/);
    await expect(db.artifacts.saveMany([report])).rejects.toThrow(/COMPARISON_REPORT must be published through the Comparison Report publication boundary/);
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
  });
});
