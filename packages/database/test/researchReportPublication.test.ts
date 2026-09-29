import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyFinancialObservation } from '@harness/financial-data';
import { createFinancialEvidenceCandidate, decideEvidenceCandidate } from '@harness/evidence';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { ResearchReportPayload } from '@harness/schemas';
import type { ResearchReportPublicationStore } from '@harness/session-core';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

const EVIDENCE_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const FOREIGN_EVIDENCE_ID = '22222222-aaaa-4aaa-8aaa-222222222222';
const MISSING_EVIDENCE_ID = '33333333-aaaa-4aaa-8aaa-333333333333';
let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-research-report-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  if (db.raw.open) db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createExecution(id: string, command = 'research') {
  const session = await db.sessions.createSession({ sessionId: `session_${id}`, title: 'Research report test', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
  const turn = await db.sessions.createTurn({ sessionId: session.id, turnId: `turn_${id}`, input: 'Assess revenue growth.', command });
  const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: id, ticker: 'BBCA', command });
  return { session, turn, execution };
}

function payload(evidenceId = EVIDENCE_ID): ResearchReportPayload {
  return {
    question: 'Assess the quality of the company’s revenue growth.',
    summary: 'Revenue growth is supported by a primary company filing.',
    findings: [{
      statement: 'Revenue increased during FY2025.', evidenceIds: [evidenceId], confidence: 'high',
      citedFigures: [{ evidenceId, path: 'financials.revenueGrowthYoy', value: 12.4, periodLabel: 'FY2025' }],
    }],
    sourceAssessments: [{ evidenceId, quality: 'primary', rationale: 'Company filing.' }],
    gaps: ['The latest interim filing is not available.'],
    coverage: [
      { source: 'company_report', status: 'available', evidenceIds: [evidenceId] },
      { source: 'news', status: 'unavailable', reason: 'Provider returned no articles.' },
      { source: 'market_data', status: 'not_requested' },
    ],
  };
}

function publicationStore(): ResearchReportPublicationStore {
  return db.researchReportPublication;
}

function acceptLegacyEvidence(executionId: string, evidenceId: string, ticker = 'BBCA') {
  return insertLegacyEvidenceFixture(db.raw, { runId: executionId, ticker, source: `legacy.${evidenceId}`, data: { value: evidenceId } });
}

async function acceptCurrentEvidence(executionId: string): Promise<string> {
  const data = { ticker: 'BBCA', asOf: '2026-09-18', financials: { roe: 23.1 }, valuation: { pe: 10 } };
  const observation = verifyFinancialObservation('company_report', { data, metadata: {
    providerId: 'sectors', source: 'sectors.company_report', origin: 'MOCK', fetchedAt: null,
    dataAsOf: null, requestedAsOf: null, period: null, derivedFrom: [],
  } }, 'BBCA');
  const decision = decideEvidenceCandidate(createFinancialEvidenceCandidate({ executionId, ticker: 'BBCA', observation }), '2026-09-20T00:00:00.000Z');
  if (!decision.accepted) throw new Error('test candidate should be accepted');
  const stored = await db.evidence.accept({ runId: executionId, ticker: 'BBCA', source: decision.source, data: decision.data, acceptance: decision });
  return stored.id;
}

describe('ResearchReportPublicationStore', () => {
  it('exposes the narrow atomic publication operation for a running research execution', async () => {
    const owner = await createExecution('run_research_1');
    const evidenceId = await acceptCurrentEvidence(owner.execution.id);

    const published = await publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(evidenceId), executionTimeSeconds: 2.5 });

    expect(published).toMatchObject({
      execution: { id: owner.execution.id, status: 'completed', command: 'research', executionTime: 2.5, error: null },
      artifact: {
        artifactId: `artifact_research_report_${owner.execution.id}`, kind: 'RESEARCH_REPORT', schemaVersion: 1,
        sessionId: owner.session.id, turnId: owner.turn.id, executionId: owner.execution.id, ticker: 'BBCA', payload: payload(evidenceId),
      },
    });
    expect(published.execution.completedAt).toBe(published.artifact.createdAt);
    expect(published.execution.resumeGeneration).toBe(owner.execution.resumeGeneration);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).session.updatedAt).toBe(published.execution.completedAt);
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([published.artifact]);

    db.raw.close();
    db = openDb({ homeDir: dir });
    expect(await db.sessions.getSessionArtifacts(owner.session.id)).toMatchObject({ executions: [published.execution] });
    expect(await db.artifacts.getById(published.artifact.artifactId)).toEqual(published.artifact);
  });

  it('rolls execution completion back when artifact publication fails validation', async () => {
    const owner = await createExecution('run_research_rollback');
    const accepted = acceptLegacyEvidence(owner.execution.id, EVIDENCE_ID);
    db.raw.exec(`CREATE TRIGGER reject_research_report BEFORE INSERT ON artifacts
      WHEN NEW.kind = 'RESEARCH_REPORT' BEGIN SELECT RAISE(ABORT, 'forced report publication failure'); END;`);
    await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(accepted.id), executionTimeSeconds: 3 }))
      .rejects.toThrow(/forced report publication failure/);

    expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]).toMatchObject({ status: 'running', completedAt: null });
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
    await expect(db.sessions.settleExecution(owner.execution.id, 'failed', { error: 'Report validation failed.' })).resolves.toMatchObject({ status: 'failed' });
  });

  it('rejects Research Reports written through the generic ArtifactStore path', async () => {
    const owner = await createExecution('run_research_generic_artifact_write');
    await db.sessions.settleExecution(owner.execution.id, 'completed');

    await expect(db.artifacts.save({
      artifactId: `artifact_research_report_${owner.execution.id}`, kind: 'RESEARCH_REPORT', schemaVersion: 1,
      sessionId: owner.session.id, turnId: owner.turn.id, executionId: owner.execution.id, ticker: 'BBCA',
      payload: { question: 'Assess BBCA.', summary: 'The report is schema-valid.', findings: [], sourceAssessments: [], gaps: [], coverage: [] },
      createdAt: '2026-09-20T00:00:00.000Z',
    })).rejects.toThrow(/RESEARCH_REPORT must be published through the Research Report publication boundary/);
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
  });

  it('rejects partial legacy acceptance metadata during atomic publication', async () => {
    const owner = await createExecution('run_research_partial_legacy_membership');
    const accepted = acceptLegacyEvidence(owner.execution.id, EVIDENCE_ID);
    db.raw.prepare('UPDATE run_evidence SET policy_fingerprint = ? WHERE run_id = ? AND evidence_id = ?')
      .run('partial', owner.execution.id, accepted.id);

    await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(accepted.id), executionTimeSeconds: 1 }))
      .rejects.toThrow(/partial acceptance metadata/);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]?.status).toBe('running');
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
  });

  it('rejects corrupt current-policy acceptance metadata during atomic publication', async () => {
    const owner = await createExecution('run_research_corrupt_current_membership');
    const evidenceId = await acceptCurrentEvidence(owner.execution.id);
    db.raw.prepare('UPDATE run_evidence SET policy_fingerprint = ? WHERE run_id = ? AND evidence_id = ?')
      .run('0'.repeat(64), owner.execution.id, evidenceId);

    await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(evidenceId), executionTimeSeconds: 1 }))
      .rejects.toThrow(/is corrupt/);
    expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]?.status).toBe('running');
    expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
  });

  it('accepts same-execution Evidence and independently rejects a foreign reference at each report location', async () => {
    const foreign = await createExecution('run_research_evidence_foreign');
    const foreignEvidence = acceptLegacyEvidence(foreign.execution.id, FOREIGN_EVIDENCE_ID);
    const locations = [
      ['finding.evidenceIds', (report: ResearchReportPayload) => ({ ...report, findings: [{ ...report.findings[0]!, evidenceIds: [foreignEvidence.id] }] })],
      ['finding.citedFigures[].evidenceId', (report: ResearchReportPayload) => ({ ...report, findings: [{ ...report.findings[0]!, citedFigures: [{ evidenceId: foreignEvidence.id, path: 'financials.revenue', value: 1, periodLabel: 'FY2025' }] }] })],
      ['sourceAssessments[].evidenceId', (report: ResearchReportPayload) => ({ ...report, sourceAssessments: [{ evidenceId: foreignEvidence.id, quality: 'primary' as const, rationale: 'Foreign source.' }] })],
      ['coverage[available].evidenceIds', (report: ResearchReportPayload) => ({ ...report, coverage: [{ source: 'company_report', status: 'available' as const, evidenceIds: [foreignEvidence.id] }] })],
    ] as const;

    for (const [index, [location, addForeignReference]] of locations.entries()) {
      const owner = await createExecution(`run_research_foreign_${index}`);
      const ownerEvidence = acceptLegacyEvidence(owner.execution.id, `44444444-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`);
      const normalPayload = payload(ownerEvidence.id);
      const foreignPayload = addForeignReference(normalPayload);
      await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: foreignPayload, executionTimeSeconds: 1 }), location)
        .rejects.toThrow(new RegExp(foreignEvidence.id));
      expect((await db.sessions.getSessionArtifacts(owner.session.id)).executions[0]?.status).toBe('running');
      expect(await db.artifacts.getByExecution(owner.execution.id)).toEqual([]);
    }

    const missing = await createExecution('run_research_missing_evidence');
    await expect(publicationStore().completeAndPublish({ executionId: missing.execution.id, payload: payload(MISSING_EVIDENCE_ID), executionTimeSeconds: 1 })).rejects.toThrow(/evidence|membership|belong/i);
    expect((await db.sessions.getSessionArtifacts(missing.session.id)).executions[0]?.status).toBe('running');
  });

  it('rejects producer mismatches and non-running lifecycle states', async () => {
    const judge = await createExecution('run_judge_for_research_report', 'judge');
    await expect(publicationStore().completeAndPublish({ executionId: judge.execution.id, payload: payload(), executionTimeSeconds: 1 })).rejects.toThrow(/research|producer|command/i);

    const research = await createExecution('run_research_for_bull_case');
    await db.sessions.settleExecution(research.execution.id, 'completed');
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const bullArgument = {
      messageId: 'bull-message', reasoning: 'The filing supports this positive assessment of the company.',
      claims: [{ claimId: 'claim-1', statement: 'Revenue grew.', confidence: 'strong', reasoning: 'The reported figure supports growth.', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId],
    };
    await expect(db.artifacts.save({
      artifactId: 'artifact_bull_case_run_research_for_bull_case', kind: 'BULL_CASE', schemaVersion: 1,
      sessionId: research.session.id, turnId: research.turn.id, executionId: research.execution.id, ticker: 'BBCA',
      payload: { thesis: bullArgument, rebuttal: { ...bullArgument, messageId: 'bull-rebuttal' } }, createdAt: '2026-09-20T00:00:00.000Z',
    } as never)).rejects.toThrow(/judge execution/i);

    const failed = await createExecution('run_research_failed');
    await db.sessions.settleExecution(failed.execution.id, 'failed', { error: 'failed' });
    await expect(publicationStore().completeAndPublish({ executionId: failed.execution.id, payload: payload(), executionTimeSeconds: 1 })).rejects.toThrow(/failed|terminal|cannot/i);

    const cancelled = await createExecution('run_research_cancelled');
    await db.sessions.settleExecution(cancelled.execution.id, 'cancelled');
    await expect(publicationStore().completeAndPublish({ executionId: cancelled.execution.id, payload: payload(), executionTimeSeconds: 1 })).rejects.toThrow(/cancelled|terminal|cannot/i);

    const interrupted = await createExecution('run_research_interrupted');
    await db.sessions.interruptExecution(interrupted.execution.id);
    await expect(publicationStore().completeAndPublish({ executionId: interrupted.execution.id, payload: payload(), executionTimeSeconds: 1 })).rejects.toThrow(/interrupted|terminal|cannot/i);
  });

  it('returns an exact committed retry without transitioning again and rejects conflicts or impossible partial state', async () => {
    const owner = await createExecution('run_research_retry');
    const accepted = acceptLegacyEvidence(owner.execution.id, EVIDENCE_ID);
    const first = await publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(accepted.id), executionTimeSeconds: 1.5 });
    const retry = await publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: payload(accepted.id), executionTimeSeconds: 99 });
    expect(retry).toEqual(first);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE execution_id = ?').get(owner.execution.id)).toEqual({ count: 1 });
    await expect(publicationStore().completeAndPublish({ executionId: owner.execution.id, payload: { ...payload(accepted.id), summary: 'Conflicting report payload.' }, executionTimeSeconds: 1.5 })).rejects.toThrow(/conflict|immutable/i);

    const impossible = await createExecution('run_research_completed_missing_report');
    await db.sessions.settleExecution(impossible.execution.id, 'completed');
    await expect(publicationStore().completeAndPublish({ executionId: impossible.execution.id, payload: payload(), executionTimeSeconds: 1 })).rejects.toThrow(/missing|partial|report/i);
  });
});
