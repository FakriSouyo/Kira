import { describe, expect, it } from 'vitest';
import {
  applyWorkingContextPatch,
  type ArtifactStore,
  type ArtifactRef,
  type ArtifactEnvelope,
  type SessionWorkingContext,
} from '@harness/session-core';
import type {
  BearCaseArtifactPayload,
  BullCaseArtifactPayload,
  VerdictArtifactPayload,
} from '@harness/schemas';
import {
  assembleContext,
  ContextIntegrityError,
  ContextPacketSchema,
  resolveContextCandidates,
  selectContextCandidates,
  type ContextDiagnostic,
  type ContextPolicyInput,
} from '../src/index.js';

const EVIDENCE_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const BULL_ARGUMENT = {
  messageId: 'bull_message',
  reasoning: 'Profitability and growth support the bullish case for the company.',
  claims: [{
    claimId: 'claim_1', statement: 'Profitability remains strong for the company.', confidence: 'strong' as const,
    reasoning: 'The observed return on equity supports this conclusion.', evidenceIds: [EVIDENCE_ID],
  }],
  evidenceIds: [EVIDENCE_ID],
};
const BULL_PAYLOAD: BullCaseArtifactPayload = {
  thesis: BULL_ARGUMENT,
  rebuttal: { ...BULL_ARGUMENT, messageId: 'bull_rebuttal' },
};
const BEAR_PAYLOAD: BearCaseArtifactPayload = {
  messageId: 'bear_message',
  reasoning: 'Valuation leaves a downside challenge for the company.',
  counterpoints: [{ targetClaimId: 'claim_1', argument: 'The claim may overlook valuation risk.', strength: 'moderate' }],
  evidenceIds: [EVIDENCE_ID],
};
const JUDGMENT = {
  ticker: 'BBRI', score: 72, stance: 'bullish' as const, confidence: 'moderate' as const,
  breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
  summary: 'Consistent, evidence-backed signals support a bullish stance.',
};
const VERDICT_PAYLOAD: VerdictArtifactPayload = {
  judgment: JUDGMENT, evidenceIds: [EVIDENCE_ID], claimIds: ['claim_1'], rounds: 1,
};

type ArtifactKind = ArtifactEnvelope['kind'];

function artifact(kind: ArtifactKind, artifactId: string, overrides: Partial<ArtifactEnvelope> = {}): ArtifactEnvelope {
  const payload = kind === 'BULL_CASE' ? BULL_PAYLOAD : kind === 'BEAR_CASE' ? BEAR_PAYLOAD : VERDICT_PAYLOAD;
  return {
    artifactId, kind, schemaVersion: 1, sessionId: 'session_1', turnId: 'turn_1', executionId: 'run_1',
    ticker: 'BBRI', payload, createdAt: '2026-09-18T00:00:00.000Z', ...overrides,
  } as ArtifactEnvelope;
}

class MemoryArtifactStore implements ArtifactStore {
  readonly artifacts = new Map<string, ArtifactEnvelope>();
  resolveCalls: ArtifactRef[] = [];
  getByIdCalls: string[] = [];

  async save(value: ArtifactEnvelope): Promise<ArtifactEnvelope> { this.artifacts.set(value.artifactId, value); return value; }
  async saveMany(values: readonly ArtifactEnvelope[]): Promise<ArtifactEnvelope[]> { values.forEach(value => this.artifacts.set(value.artifactId, value)); return [...values]; }
  async getById(artifactId: string): Promise<ArtifactEnvelope | null> {
    this.getByIdCalls.push(artifactId);
    return this.artifacts.get(artifactId) ?? null;
  }
  async getByExecution(executionId: string): Promise<ArtifactEnvelope[]> {
    return [...this.artifacts.values()].filter(value => value.executionId === executionId);
  }
  async listByQuery(query: { sessionId: string; subjects: string[]; allowedKinds: ArtifactKind[]; focus: 'generic' | 'downside' | 'thesis' | 'bull' | 'bear' }): Promise<ArtifactEnvelope[]> {
    return [...this.artifacts.values()].filter(value => value.sessionId === query.sessionId && query.subjects.includes(value.ticker) && query.allowedKinds.includes(value.kind));
  }
  async getSourceExecution(_executionId: string): Promise<null> { return null; }
  async resolve(ref: Extract<ArtifactRef, { kind: ArtifactKind }>): Promise<ArtifactEnvelope | null> {
    this.resolveCalls.push(ref);
    const value = this.artifacts.get(ref.artifactId);
    return value?.kind === ref.kind ? value : null;
  }
}

function ref(kind: ArtifactKind, artifactId: string): Extract<ArtifactRef, { kind: ArtifactKind }> {
  return { kind, artifactId };
}

function context(overrides: Partial<SessionWorkingContext> = {}): SessionWorkingContext {
  return {
    ...applyWorkingContextPatch(null, {
      sessionId: 'session_1', sourceSequence: 9, updatedByTurnId: 'turn_1', updatedAt: '2026-09-18T00:00:00.000Z',
      patch: { activeSubjects: [{ ticker: 'BBRI' }], currentIntent: { command: 'conversation' } },
    }),
    ...overrides,
  };
}

function storeWith(...values: ArtifactEnvelope[]): MemoryArtifactStore {
  const store = new MemoryArtifactStore();
  values.forEach(value => store.artifacts.set(value.artifactId, value));
  return store;
}

async function resolved(store: MemoryArtifactStore, workingContext = context()) {
  return resolveContextCandidates({ sessionId: 'session_1', workingContext, artifactStore: store });
}

describe('ContextPacket contract', () => {
  it('assembles a schema-versioned packet that passes runtime validation', async () => {
    const store = storeWith(artifact('VERDICT', 'verdict_1'));
    const resolution = await resolved(store, context({ activeVerdictRef: ref('VERDICT', 'verdict_1') }));
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'generic' } });
    const result = assembleContext({ sessionId: 'session_1', turnId: 'turn_2', workingContext: context({ activeVerdictRef: ref('VERDICT', 'verdict_1') }), selectedCandidates: selection.selected, sourceRefs: resolution.sourceRefs, diagnostics: [...resolution.diagnostics, ...selection.diagnostics] });

    expect(result.packet.schemaVersion).toBe(1);
    expect(ContextPacketSchema.parse(result.packet)).toEqual(result.packet);
    expect(result.packet.turnId).toBe('turn_2');
  });

  it('rejects a packet with an unsupported schema version', () => {
    expect(() => ContextPacketSchema.parse({ schemaVersion: 2 })).toThrow();
  });
});

describe('Reference Resolver', () => {
  it('resolves a valid Verdict ref with its active role', async () => {
    const store = storeWith(artifact('VERDICT', 'verdict_1'));
    const result = await resolved(store, context({ activeVerdictRef: ref('VERDICT', 'verdict_1') }));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ role: 'ACTIVE_VERDICT', source: 'ACTIVE', ref: ref('VERDICT', 'verdict_1') });
    expect(result.candidates[0]?.artifact.kind).toBe('VERDICT');
  });

  it('resolves Bull and Bear refs with their corresponding roles', async () => {
    const store = storeWith(artifact('BULL_CASE', 'bull_1'), artifact('BEAR_CASE', 'bear_1'));
    const result = await resolved(store, context({ activeBullCaseRef: ref('BULL_CASE', 'bull_1'), activeBearCaseRef: ref('BEAR_CASE', 'bear_1') }));
    expect(result.candidates.map(candidate => candidate.role)).toEqual(['ACTIVE_BULL_CASE', 'ACTIVE_BEAR_CASE']);
  });

  it('maps the legacy active thesis slot to real Bull semantics', async () => {
    const store = storeWith(artifact('BULL_CASE', 'bull_1'));
    const result = await resolved(store, context({ activeThesisRef: ref('BULL_CASE', 'bull_1') }));
    expect(result.candidates[0]).toMatchObject({ role: 'ACTIVE_THESIS', artifact: { kind: 'BULL_CASE' } });
  });

  it('does not synthesize candidates for null optional refs', async () => {
    const result = await resolved(storeWith());
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reports a missing pinned artifact without failing the packet', async () => {
    const result = await resolved(storeWith(), context({ pinnedArtifactRefs: [ref('VERDICT', 'missing')] }));
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_ARTIFACT', stage: 'resolver', status: 'failed' }));
  });

  it('degrades a missing optional active case while preserving its diagnostic', async () => {
    const result = await resolved(storeWith(), context({ activeBearCaseRef: ref('BEAR_CASE', 'missing_bear') }));
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_ARTIFACT', role: 'ACTIVE_BEAR_CASE' }));
  });

  it('fails explicitly when the required active Verdict artifact is missing', async () => {
    await expect(resolved(storeWith(), context({ activeVerdictRef: ref('VERDICT', 'missing') }))).rejects.toMatchObject({ code: 'MISSING_ARTIFACT' });
  });

  it('rejects malformed refs before store lookup', async () => {
    await expect(resolved(storeWith(), context({ activeVerdictRef: { kind: 'VERDICT', artifactId: '' } as never }))).rejects.toMatchObject({ code: 'MALFORMED_REF' });
  });

  it('rejects a role/ref kind mismatch', async () => {
    const store = storeWith(artifact('BULL_CASE', 'bull_1'));
    await expect(resolved(store, context({ activeVerdictRef: ref('BULL_CASE', 'bull_1') }))).rejects.toMatchObject({ code: 'ROLE_KIND_MISMATCH' });
  });

  it('rejects a stored kind mismatch instead of accepting the payload', async () => {
    const store = storeWith(artifact('BULL_CASE', 'shared_id'));
    await expect(resolved(store, context({ activeVerdictRef: ref('VERDICT', 'shared_id') }))).rejects.toMatchObject({ code: 'TYPE_MISMATCH' });
  });

  it('rejects cross-session artifacts', async () => {
    const store = storeWith(artifact('VERDICT', 'verdict_other', { sessionId: 'session_2' }));
    await expect(resolved(store, context({ activeVerdictRef: ref('VERDICT', 'verdict_other') }))).rejects.toMatchObject({ code: 'CROSS_SESSION' });
  });

  it('resolves the same typed ref after a simulated restart', async () => {
    const persisted = artifact('VERDICT', 'verdict_restart');
    const reopened = storeWith(persisted);
    const result = await resolved(reopened, context({ activeVerdictRef: ref('VERDICT', 'verdict_restart') }));
    expect(result.candidates[0]?.artifact.artifactId).toBe('verdict_restart');
  });

  it('reports legacy JudgmentRef explicitly and never fabricates a typed artifact', async () => {
    const result = await resolved(storeWith(), context({ activeVerdictRef: { kind: 'judgment', executionId: 'run_legacy' } }));
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'LEGACY_REF', status: 'skipped' }));
  });

  it('uses the same resolver path for pinned refs and does not scan unrelated artifacts', async () => {
    const store = storeWith(artifact('VERDICT', 'pinned_1'), artifact('BULL_CASE', 'unrelated'));
    const result = await resolved(store, context({ pinnedArtifactRefs: [ref('VERDICT', 'pinned_1')] }));
    expect(result.candidates).toHaveLength(1);
    expect(store.resolveCalls).toEqual([ref('VERDICT', 'pinned_1')]);
    expect(store.getByIdCalls).toEqual([]);
    expect(result.candidates.some(candidate => candidate.artifact.artifactId === 'unrelated')).toBe(false);
  });

  it('does not depend on Evidence or provider-cache interfaces', async () => {
    const store = storeWith(artifact('VERDICT', 'verdict_1'));
    const result = await resolved(store, context({ activeVerdictRef: ref('VERDICT', 'verdict_1') }));
    expect(result.candidates[0]?.artifact.payload).toHaveProperty('evidenceIds');
    expect(result.candidates[0]).not.toHaveProperty('evidence');
  });
});

describe('Context Policy', () => {
  async function candidates() {
    const workingContext = context({
      activeThesisRef: ref('BULL_CASE', 'bull_1'), activeBullCaseRef: ref('BULL_CASE', 'bull_1'),
      activeBearCaseRef: ref('BEAR_CASE', 'bear_1'), activeVerdictRef: ref('VERDICT', 'verdict_1'),
    });
    return (await resolved(storeWith(artifact('BULL_CASE', 'bull_1'), artifact('BEAR_CASE', 'bear_1'), artifact('VERDICT', 'verdict_1')), workingContext)).candidates;
  }

  it('includes explicitly active context by default in stable role order', async () => {
    const result = selectContextCandidates({ candidates: await candidates(), intent: { focus: 'generic' } });
    expect(result.selected.map(candidate => candidate.role)).toEqual(['ACTIVE_THESIS', 'ACTIVE_BULL_CASE', 'ACTIVE_BEAR_CASE', 'ACTIVE_VERDICT']);
  });

  it('selects Bear and Verdict for a structured downside focus', async () => {
    const result = selectContextCandidates({ candidates: await candidates(), intent: { focus: 'downside' } });
    expect(result.selected.map(candidate => candidate.role)).toEqual(['ACTIVE_BEAR_CASE', 'ACTIVE_VERDICT']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ status: 'skipped', reason: 'not-relevant-to-intent' }));
  });

  it('selects actual Bull/thesis semantics for a structured thesis focus', async () => {
    const result = selectContextCandidates({ candidates: await candidates(), intent: { focus: 'thesis' } });
    expect(result.selected.map(candidate => candidate.role)).toEqual(['ACTIVE_THESIS', 'ACTIVE_BULL_CASE']);
  });

  it('uses generic selection when no semantic focus is supplied', async () => {
    const result = selectContextCandidates({ candidates: await candidates(), intent: {} });
    expect(result.selected).toHaveLength(4);
  });
});

describe('Context Assembler', () => {
  async function assembled(overrides: Partial<SessionWorkingContext> = {}, policy: ContextPolicyInput = { focus: 'generic' }) {
    const workingContext = context(overrides);
    const store = storeWith(artifact('BULL_CASE', 'bull_1'), artifact('BEAR_CASE', 'bear_1'), artifact('VERDICT', 'verdict_1'));
    const resolution = await resolved(store, workingContext);
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: policy });
    return assembleContext({
      sessionId: 'session_1', turnId: 'turn_follow_up', workingContext,
      selectedCandidates: selection.selected, sourceRefs: resolution.sourceRefs,
      diagnostics: [...resolution.diagnostics, ...selection.diagnostics], intent: { command: 'conversation' },
    });
  }

  it('orders artifacts thesis, bull, bear, verdict, then pinned', async () => {
    const result = await assembled({
      activeThesisRef: ref('BULL_CASE', 'bull_1'), activeBullCaseRef: ref('BULL_CASE', 'bull_1'),
      activeBearCaseRef: ref('BEAR_CASE', 'bear_1'), activeVerdictRef: ref('VERDICT', 'verdict_1'),
    });
    expect(result.packet.artifacts.map(item => item.artifact.artifactId)).toEqual(['bull_1', 'bear_1', 'verdict_1']);
  });

  it('deduplicates active and pinned copies while retaining both roles and refs', async () => {
    const workingContext = context({ activeVerdictRef: ref('VERDICT', 'verdict_1'), pinnedArtifactRefs: [ref('VERDICT', 'verdict_1')] });
    const store = storeWith(artifact('VERDICT', 'verdict_1'));
    const resolution = await resolved(store, workingContext);
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'generic' } });
    const result = assembleContext({ sessionId: 'session_1', turnId: 'turn_2', workingContext, selectedCandidates: selection.selected, sourceRefs: resolution.sourceRefs, diagnostics: selection.diagnostics });
    expect(result.packet.artifacts).toHaveLength(1);
    expect(result.packet.artifacts[0]?.roles).toEqual(['ACTIVE_VERDICT', 'PINNED_ARTIFACT']);
    expect(result.packet.artifacts[0]?.sourceRefs).toHaveLength(2);
  });

  it('preserves multi-subject state and provenance without rewriting it from payloads', async () => {
    const result = await assembled({ activeSubjects: [{ ticker: 'BBRI' }, { ticker: 'BMRI' }], activeVerdictRef: ref('VERDICT', 'verdict_1') });
    expect(result.packet.activeSubjects).toEqual([{ ticker: 'BBRI' }, { ticker: 'BMRI' }]);
    expect(result.packet.provenance).toMatchObject({ sessionId: 'session_1', turnId: 'turn_follow_up', workingContextVersion: 1, sourceContextSequence: 9, selectedArtifactIds: ['verdict_1'] });
  });

  it('keeps assertions, assumptions, and open questions as separate trust-typed values', async () => {
    const result = await assembled({
      userAssertions: [{ kind: 'USER_ASSERTION', id: 'assert_1', text: 'NIM akan turun', turnId: 'turn_1' }],
      assumptions: [{ kind: 'ASSUMPTION', id: 'assume_1', text: 'margin stays flat', turnId: 'turn_1' }],
      unresolvedQuestions: [{ kind: 'OPEN_QUESTION', id: 'question_1', text: 'why did BBRI fall?', turnId: 'turn_1' }],
    });
    expect(result.packet.userAssertions[0]?.kind).toBe('USER_ASSERTION');
    expect(result.packet.assumptions[0]?.kind).toBe('ASSUMPTION');
    expect(result.packet.unresolvedQuestions[0]?.kind).toBe('OPEN_QUESTION');
    expect(result.packet.artifacts).toEqual([]);
  });

  it('is semantically identical and deeply immutable across repeated assembly', async () => {
    const first = await assembled({ activeVerdictRef: ref('VERDICT', 'verdict_1') });
    const second = await assembled({ activeVerdictRef: ref('VERDICT', 'verdict_1') });
    expect(first.packet).toEqual(second.packet);
    expect(Object.isFrozen(first.packet)).toBe(true);
    expect(Object.isFrozen(first.packet.artifacts)).toBe(true);
    expect(Object.isFrozen(first.packet.artifacts[0]?.artifact)).toBe(true);
  });

  it('does not mutate working context, create executions, emit events, or expand Evidence', async () => {
    const workingContext = context({ activeVerdictRef: ref('VERDICT', 'verdict_1') });
    const before = structuredClone(workingContext);
    const store = storeWith(artifact('VERDICT', 'verdict_1'));
    const resolution = await resolved(store, workingContext);
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'generic' } });
    assembleContext({ sessionId: 'session_1', turnId: 'turn_2', workingContext, selectedCandidates: selection.selected, sourceRefs: resolution.sourceRefs, diagnostics: selection.diagnostics });
    expect(workingContext).toEqual(before);
    expect(store.getByIdCalls).toEqual([]);
  });

  it('retains typed artifact payloads without bulk Evidence expansion', async () => {
    const result = await assembled({ activeVerdictRef: ref('VERDICT', 'verdict_1') });
    const verdict = result.packet.artifacts[0]?.artifact;
    expect(verdict?.kind).toBe('VERDICT');
    expect(verdict?.payload).toMatchObject({ judgment: { ticker: 'BBRI' }, evidenceIds: [EVIDENCE_ID] });
    expect(verdict).not.toHaveProperty('evidence');
  });

  it('records resolver and policy diagnostics in packet provenance', async () => {
    const workingContext = context({ activeVerdictRef: ref('VERDICT', 'verdict_1'), pinnedArtifactRefs: [ref('VERDICT', 'missing')] });
    const resolution = await resolved(storeWith(artifact('VERDICT', 'verdict_1')), workingContext);
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'generic' } });
    const result = assembleContext({ sessionId: 'session_1', turnId: 'turn_2', workingContext, selectedCandidates: selection.selected, sourceRefs: resolution.sourceRefs, diagnostics: [...resolution.diagnostics, ...selection.diagnostics] });
    expect(result.packet.provenance.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_ARTIFACT' }));
  });
});

describe('Context integrity', () => {
  it('rejects malformed stored artifacts rather than exposing unvalidated payloads', async () => {
    const store = storeWith({ artifactId: 'bad', kind: 'VERDICT', payload: {} } as never);
    await expect(resolved(store, context({ activeVerdictRef: ref('VERDICT', 'bad') }))).rejects.toMatchObject({ code: 'MALFORMED_ARTIFACT' });
  });

  it('rejects an active artifact whose ticker conflicts with active subjects', async () => {
    const store = storeWith(artifact('VERDICT', 'verdict_other', { ticker: 'BBCA' }));
    await expect(resolved(store, context({ activeVerdictRef: ref('VERDICT', 'verdict_other') }))).rejects.toMatchObject({ code: 'SUBJECT_MISMATCH' });
  });

  it('rejects a packet assembled for the wrong session', async () => {
    const store = storeWith(artifact('VERDICT', 'verdict_1'));
    const resolution = await resolved(store, context({ activeVerdictRef: ref('VERDICT', 'verdict_1') }));
    const selection = selectContextCandidates({ candidates: resolution.candidates, intent: { focus: 'generic' } });
    expect(() => assembleContext({ sessionId: 'session_2', turnId: 'turn_2', workingContext: context({ activeVerdictRef: ref('VERDICT', 'verdict_1') }), selectedCandidates: selection.selected, sourceRefs: resolution.sourceRefs, diagnostics: [] })).toThrow(ContextIntegrityError);
  });
});

describe('Context diagnostics typing', () => {
  it('keeps diagnostics stable and structured', () => {
    const diagnostic: ContextDiagnostic = { stage: 'policy', status: 'skipped', code: 'NOT_RELEVANT', reason: 'not-relevant-to-intent', role: 'ACTIVE_BULL_CASE' };
    expect(diagnostic).toMatchObject({ stage: 'policy', status: 'skipped' });
  });
});
