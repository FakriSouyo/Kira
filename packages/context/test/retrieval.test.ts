import { describe, expect, it } from 'vitest';
import type { ArtifactEnvelope, ArtifactKind } from '@harness/schemas';
import { applyWorkingContextPatch, type SessionWorkingContext } from '@harness/session-core';
import { evaluateArtifactValidity, retrieveArtifactCandidates } from '../src/index.js';
import { resolveContextCandidates, selectContextCandidates } from '../src/index.js';

const EVIDENCE_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const BULL_PAYLOAD = {
  thesis: {
    messageId: 'bull-message',
    reasoning: 'Profitability and growth support the bullish case for the company.',
    claims: [{
      claimId: 'claim-1', statement: 'Profitability remains strong.', confidence: 'strong',
      reasoning: 'Return on equity supports the conclusion.', evidenceIds: [EVIDENCE_ID],
    }], evidenceIds: [EVIDENCE_ID],
  },
  rebuttal: {
    messageId: 'bull-rebuttal',
    reasoning: 'The rebuttal preserves the strongest supported thesis.',
    claims: [{
      claimId: 'claim-2', statement: 'Growth remains durable.', confidence: 'moderate',
      reasoning: 'The observed growth supports the conclusion.', evidenceIds: [EVIDENCE_ID],
    }], evidenceIds: [EVIDENCE_ID],
  },
} as const;

function bull(artifactId: string, ticker: string, createdAt: string): ArtifactEnvelope {
  return {
    artifactId, kind: 'BULL_CASE', schemaVersion: 1, sessionId: 'session-1', turnId: artifactId,
    executionId: `execution-${artifactId}`, ticker, payload: BULL_PAYLOAD as never, createdAt,
  } as ArtifactEnvelope;
}

function bear(artifactId: string, ticker: string, createdAt: string): ArtifactEnvelope {
  return {
    artifactId, kind: 'BEAR_CASE', schemaVersion: 1, sessionId: 'session-1', turnId: artifactId,
    executionId: `execution-${artifactId}`, ticker,
    payload: {
      messageId: 'bear-message',
      reasoning: 'Margin pressure may weaken future returns.',
      counterpoints: [{ targetClaimId: 'claim-1', argument: 'Margin pressure could persist.', strength: 'moderate' }],
      evidenceIds: [EVIDENCE_ID],
    },
    createdAt,
  } as ArtifactEnvelope;
}

function verdict(artifactId: string, ticker: string, createdAt: string): ArtifactEnvelope {
  return {
    artifactId, kind: 'VERDICT', schemaVersion: 1, sessionId: 'session-1', turnId: artifactId,
    executionId: `execution-${artifactId}`, ticker,
    payload: {
      judgment: {
        ticker, score: 70, stance: 'bullish', confidence: 'high',
        breakdown: { financialHealth: 70, growth: 70, valuation: 70, marketMomentum: null, risk: null },
        summary: 'The evidence supports a positive overall assessment.',
      },
      evidenceIds: [EVIDENCE_ID], claimIds: ['claim-1'], rounds: 1,
    },
    createdAt,
  } as ArtifactEnvelope;
}

function researchReport(artifactId: string): ArtifactEnvelope {
  return {
    artifactId, kind: 'RESEARCH_REPORT', schemaVersion: 1, sessionId: 'session-1', turnId: artifactId,
    executionId: `execution-${artifactId}`, ticker: 'BBRI',
    payload: {
      question: 'Assess revenue quality.', summary: 'Revenue grew based on the available filing.',
      findings: [{ statement: 'Revenue increased.', evidenceIds: [EVIDENCE_ID], confidence: 'high' }],
      sourceAssessments: [{ evidenceId: EVIDENCE_ID, quality: 'primary', rationale: 'Issuer filing.' }],
      gaps: [], coverage: [{ source: 'company_report', status: 'available', evidenceIds: [EVIDENCE_ID] }],
    },
    createdAt: '2026-09-18T02:00:00.000Z',
  } as ArtifactEnvelope;
}

function comparisonReport(artifactId: string): ArtifactEnvelope {
  return {
    artifactId, kind: 'COMPARISON_REPORT', schemaVersion: 1, sessionId: 'session-1', turnId: artifactId,
    executionId: `execution-${artifactId}`, ticker: 'BBRI',
    payload: {
      subjects: [{ ticker: 'BBRI' }, { ticker: 'BBCA' }], selectedPeriod: '2026-Q2',
      metrics: [
        { metric: 'revenueGrowthYoy', unit: 'percent', status: 'comparable', cells: [
          { ticker: 'BBRI', status: 'available', value: 10, unit: 'percent', source: { evidenceId: EVIDENCE_ID, path: 'quarters.revenueGrowthYoy', periodLabel: '2026-Q2' } },
          { ticker: 'BBCA', status: 'available', value: 5, unit: 'percent', source: { evidenceId: EVIDENCE_ID, path: 'quarters.revenueGrowthYoy', periodLabel: '2026-Q2' } },
        ] },
        { metric: 'netIncomeGrowthYoy', unit: 'percent', status: 'unavailable', cells: [
          { ticker: 'BBRI', status: 'unavailable', reason: 'VALUE_MISSING', unit: 'percent', source: { evidenceId: EVIDENCE_ID, path: 'quarters.netIncomeGrowthYoy', periodLabel: '2026-Q2' } },
          { ticker: 'BBCA', status: 'unavailable', reason: 'VALUE_MISSING', unit: 'percent', source: { evidenceId: EVIDENCE_ID, path: 'quarters.netIncomeGrowthYoy', periodLabel: '2026-Q2' } },
        ] },
      ],
      differences: [{ metric: 'revenueGrowthYoy', leftTicker: 'BBRI', rightTicker: 'BBCA', value: 5, unit: 'percentage_points',
        left: { evidenceId: EVIDENCE_ID, path: 'quarters.revenueGrowthYoy', periodLabel: '2026-Q2' },
        right: { evidenceId: EVIDENCE_ID, path: 'quarters.revenueGrowthYoy', periodLabel: '2026-Q2' } }],
      warnings: [],
    },
    createdAt: '2026-09-18T02:00:00.000Z',
  };
}

function workingContext(ticker: string, activeBullCaseRef: { kind: 'BULL_CASE'; artifactId: string } | null = null): SessionWorkingContext {
  return applyWorkingContextPatch(null, {
    sessionId: 'session-1', sourceSequence: 1, updatedByTurnId: 'turn-1', updatedAt: '2026-09-18T00:00:00.000Z',
    patch: { activeSubjects: [{ ticker }], activeBullCaseRef },
  });
}

class RetrievalStore {
  readonly queries: unknown[] = [];
  constructor(private values: readonly ArtifactEnvelope[], private readonly listedValues: readonly ArtifactEnvelope[] = values) {}
  async listByQuery(query: unknown): Promise<ArtifactEnvelope[]> {
    this.queries.push(query);
    return [...this.listedValues];
  }
  async resolve(ref: { artifactId: string; kind: ArtifactKind }) {
    const value = this.values.find(candidate => candidate.artifactId === ref.artifactId);
    return value?.kind === ref.kind ? value : null;
  }
  async getById(artifactId: string) { return this.values.find(candidate => candidate.artifactId === artifactId) ?? null; }
  async getSourceExecution(executionId: string) {
    const artifact = this.values.find(candidate => candidate.executionId === executionId);
    return {
      id: executionId, sessionId: 'session-1', turnId: artifact?.turnId ?? executionId.replace('execution-', ''), attempt: 1,
      ticker: artifact?.ticker ?? 'BBRI', command: artifact?.kind === 'RESEARCH_REPORT' ? 'research' : 'judge',
      status: 'completed' as const, createdAt: '2026-09-18T00:00:00.000Z', completedAt: '2026-09-18T00:01:00.000Z',
    };
  }
}

describe('artifact candidate retrieval', () => {
  it('discovers only bounded same-session subject/kind candidates with retrieval provenance', async () => {
    const store = new RetrievalStore([
      bull('bbri-new', 'BBRI', '2026-09-18T02:00:00.000Z'),
      bull('bbri-old', 'BBRI', '2026-09-18T01:00:00.000Z'),
      bull('bmri', 'BMRI', '2026-09-18T03:00:00.000Z'),
    ]);

    const result = await retrieveArtifactCandidates({
      artifactStore: store,
      query: { sessionId: 'session-1', subjects: ['BBRI'], allowedKinds: ['BULL_CASE'] as ArtifactKind[], focus: 'thesis' },
    });

    expect(store.queries).toEqual([{
      sessionId: 'session-1', subjects: ['BBRI'], allowedKinds: ['BULL_CASE'], focus: 'thesis',
    }]);
    expect(result.candidates.map(candidate => candidate.artifact.artifactId)).toEqual(['bbri-new']);
    expect(result.candidates.every(candidate => candidate.source === 'RETRIEVED')).toBe(true);
    expect(result.candidates.every(candidate => candidate.role === 'RETRIEVED_BULL_CASE')).toBe(true);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ artifactId: 'bbri-old', reason: 'SUPERSEDED' }));
  });

  it('maps only Judge kinds to retrieval roles and skips Research Reports as unsupported', async () => {
    const values = [
      bull('bull-prior', 'BBRI', '2026-09-18T01:00:00.000Z'),
      bear('bear-prior', 'BBRI', '2026-09-18T02:00:00.000Z'),
      verdict('verdict-prior', 'BBRI', '2026-09-18T03:00:00.000Z'),
      researchReport('research-prior'),
      comparisonReport('comparison-prior'),
    ];
    const result = await retrieveArtifactCandidates({
      artifactStore: new RetrievalStore(values),
      query: { sessionId: 'session-1', subjects: ['BBRI'], allowedKinds: ['BULL_CASE', 'BEAR_CASE', 'VERDICT', 'RESEARCH_REPORT', 'COMPARISON_REPORT'], focus: 'generic' },
    });
    expect(result.candidates.map(candidate => [candidate.artifact.kind, candidate.role])).toEqual([
      ['BULL_CASE', 'RETRIEVED_BULL_CASE'],
      ['BEAR_CASE', 'RETRIEVED_BEAR_CASE'],
      ['VERDICT', 'RETRIEVED_VERDICT'],
    ]);
    expect(result.diagnostics).toContainEqual({
      artifactId: 'research-prior', kind: 'RESEARCH_REPORT', status: 'skipped', reason: 'UNSUPPORTED_ROLE',
    });
    expect(result.diagnostics).toContainEqual({
      artifactId: 'comparison-prior', kind: 'COMPARISON_REPORT', status: 'skipped', reason: 'UNSUPPORTED_ROLE',
    });
  });

  it('accepts completed artifacts as prior context without inventing freshness', () => {
    const result = evaluateArtifactValidity({
      artifact: bull('bbri', 'BBRI', '2026-09-18T02:00:00.000Z'),
      expectedSession: 'session-1', expectedSubjects: ['BBRI'], expectedKind: 'BULL_CASE',
      sourceExecution: { id: 'execution-bbri', sessionId: 'session-1', turnId: 'bbri', attempt: 1, ticker: 'BBRI', command: 'judge', status: 'completed', createdAt: '2026-09-18T00:00:00.000Z', completedAt: '2026-09-18T00:01:00.000Z' },
    });
    expect(result).toEqual(expect.objectContaining({ status: 'VALID_AS_PRIOR' }));
    expect(result.reasons).toContain('UNKNOWN_FRESHNESS');
  });

  it('validates each Artifact kind against its canonical producer command', () => {
    const research = researchReport('research-1');
    const source = {
      id: research.executionId, sessionId: research.sessionId, turnId: research.turnId, attempt: 1, ticker: research.ticker,
      status: 'completed' as const, createdAt: '2026-09-18T00:00:00.000Z', completedAt: '2026-09-18T01:00:00.000Z',
    };
    expect(evaluateArtifactValidity({ artifact: research, expectedSession: 'session-1', expectedSubjects: ['BBRI'], sourceExecution: { ...source, command: 'research' } })).toEqual({
      status: 'VALID_AS_PRIOR', reasons: ['SCHEMA_VALID', 'SESSION_MATCH', 'SUBJECT_MATCH', 'SOURCE_EXECUTION_COMPLETED', 'UNKNOWN_FRESHNESS'],
    });
    expect(evaluateArtifactValidity({ artifact: research, expectedSession: 'session-1', expectedSubjects: ['BBRI'], sourceExecution: { ...source, command: 'judge' } }).status).toBe('INVALID');
    const researchMismatch = bull('judge-1', 'BBRI', '2026-09-18T02:00:00.000Z');
    const validJudge = bull('judge-2', 'BBRI', '2026-09-18T02:00:00.000Z');
    expect(evaluateArtifactValidity({ artifact: researchMismatch, expectedSession: 'session-1', expectedSubjects: ['BBRI'], sourceExecution: { ...source, turnId: researchMismatch.turnId, command: 'research' } }).status).toBe('INVALID');
    expect(evaluateArtifactValidity({ artifact: validJudge, expectedSession: 'session-1', expectedSubjects: ['BBRI'], sourceExecution: { ...source, turnId: validJudge.turnId, command: 'judge' } }).status).toBe('VALID_AS_PRIOR');
  });

  it.each([
    ['running', 'SOURCE_EXECUTION_INCOMPLETE'],
    ['failed', 'SOURCE_EXECUTION_INCOMPLETE'],
    ['cancelled', 'SOURCE_EXECUTION_INCOMPLETE'],
  ] as const)('rejects artifacts from a %s source execution', (status, reason) => {
    const result = evaluateArtifactValidity({
      artifact: bull(`bad-${status}`, 'BBRI', '2026-09-18T02:00:00.000Z'), expectedSession: 'session-1', expectedSubjects: ['BBRI'],
      sourceExecution: { id: `execution-${status}`, sessionId: 'session-1', turnId: `bad-${status}`, attempt: 1, ticker: 'BBRI', command: 'judge', status, createdAt: '2026-09-18T00:00:00.000Z', completedAt: null },
    });
    expect(result).toEqual({ status: 'INVALID', reasons: expect.arrayContaining([reason]) });
  });

  it('rejects wrong session, subject, kind, and malformed payloads', () => {
    expect(evaluateArtifactValidity({ artifact: bull('wrong-session', 'BBRI', '2026-09-18T00:00:00.000Z'), expectedSession: 'session-2', expectedSubjects: ['BBRI'] }).status).toBe('INVALID');
    expect(evaluateArtifactValidity({ artifact: bull('wrong-subject', 'BMRI', '2026-09-18T00:00:00.000Z'), expectedSession: 'session-1', expectedSubjects: ['BBRI'] }).status).toBe('INVALID');
    expect(evaluateArtifactValidity({ artifact: bull('wrong-kind', 'BBRI', '2026-09-18T00:00:00.000Z'), expectedSession: 'session-1', expectedSubjects: ['BBRI'], expectedKind: 'VERDICT' }).status).toBe('INVALID');
    expect(evaluateArtifactValidity({ artifact: { artifactId: 'bad' }, expectedSession: 'session-1', expectedSubjects: ['BBRI'] }).reasons).toEqual(['MALFORMED_ARTIFACT']);
  });

  it('keeps an explicit active artifact ahead of a retrieved alternative', async () => {
    const active = bull('active', 'BBRI', '2026-09-18T01:00:00.000Z');
    const retrieved = bull('retrieved', 'BBRI', '2026-09-18T02:00:00.000Z');
    const store = new RetrievalStore([active, retrieved], [retrieved]);
    const context = workingContext('BBRI', { kind: 'BULL_CASE', artifactId: 'active' });
    const retrieval = await retrieveArtifactCandidates({ artifactStore: store, query: { sessionId: 'session-1', subjects: ['BBRI'], allowedKinds: ['BULL_CASE'], focus: 'thesis' } });
    const resolution = await resolveContextCandidates({ sessionId: 'session-1', workingContext: context, artifactStore: store, retrievedCandidates: retrieval.candidates });
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'thesis', subjects: ['BBRI'] } });
    expect(selection.selected.map(candidate => candidate.artifact.artifactId)).toEqual(['active']);
    expect(selection.diagnostics).toContainEqual(expect.objectContaining({ artifactId: 'retrieved', reason: 'superseded-by-explicit-ref' }));
  });

  it('keeps retrieved subjects isolated when active context is centered on another ticker', async () => {
    const retrieved = bull('bbri-prior', 'BBRI', '2026-09-18T02:00:00.000Z');
    const bmri = bull('bmri-active', 'BMRI', '2026-09-18T03:00:00.000Z');
    const store = new RetrievalStore([retrieved, bmri]);
    const retrieval = await retrieveArtifactCandidates({ artifactStore: store, query: { sessionId: 'session-1', subjects: ['BBRI'], allowedKinds: ['BULL_CASE'], focus: 'thesis' } });
    const resolution = await resolveContextCandidates({ sessionId: 'session-1', workingContext: workingContext('BMRI'), artifactStore: store, retrievedCandidates: retrieval.candidates });
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'thesis', subjects: ['BBRI'] } });
    expect(selection.selected.map(candidate => candidate.artifact.ticker)).toEqual(['BBRI']);
    expect(selection.selected.map(candidate => candidate.artifact.artifactId)).toEqual(['bbri-prior']);
  });
});
