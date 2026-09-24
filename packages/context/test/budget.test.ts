import { describe, expect, it } from 'vitest';
import type { ContextPacket } from '../src/contracts';
import { budgetContext, ContextBudgetError, effectiveContextWindowTokens, estimateTextTokens } from '../src/budget';

const UUID = '00000000-0000-0000-0000-000000000001';

function claim(id: string, statement = `${id} supports the durable investment conclusion.`) {
  return {
    claimId: id,
    statement,
    confidence: 'strong' as const,
    reasoning: 'The claim is grounded in the validated execution evidence and remains explicit.',
    evidenceIds: [UUID],
  };
}

function artifact(kind: 'BULL_CASE' | 'BEAR_CASE' | 'VERDICT', artifactId: string, ticker = 'BBRI') {
  if (kind === 'BULL_CASE') {
    return {
      artifactId, schemaVersion: 1 as const, sessionId: 'session-budget', turnId: 'turn-judge',
      executionId: 'run-judge', ticker, kind,
      createdAt: '2026-09-18T00:00:00.000Z',
      payload: {
        thesis: { messageId: `${artifactId}-thesis`, reasoning: 'The thesis remains supported by durable operating performance.', claims: [claim(`${artifactId}-thesis-claim`)], evidenceIds: [UUID] },
        rebuttal: { messageId: `${artifactId}-rebuttal`, reasoning: 'The rebuttal addresses the strongest competing interpretation.', claims: [claim(`${artifactId}-rebuttal-claim`)], evidenceIds: [UUID] },
      },
    };
  }
  if (kind === 'BEAR_CASE') {
    return {
      artifactId, schemaVersion: 1 as const, sessionId: 'session-budget', turnId: 'turn-judge',
      executionId: 'run-judge', ticker, kind,
      createdAt: '2026-09-18T00:00:00.000Z',
      payload: {
        messageId: `${artifactId}-bear`, reasoning: 'The downside case identifies material risks to the thesis.',
        counterpoints: [{ targetClaimId: 'bull-claim', argument: 'The risk can invalidate the expected outcome.', strength: 'high' as const }],
        evidenceIds: [UUID],
      },
    };
  }
  return {
    artifactId, schemaVersion: 1 as const, sessionId: 'session-budget', turnId: 'turn-judge',
    executionId: 'run-judge', ticker, kind,
    createdAt: '2026-09-18T00:00:00.000Z',
    payload: {
      judgment: {
        ticker, score: 72, stance: 'bullish' as const, confidence: 'moderate' as const,
        breakdown: { financialHealth: 80, growth: 70, valuation: 65, marketMomentum: null, risk: 45 },
        summary: 'The prior verdict is constructive but valuation and risk remain material constraints.',
      },
      evidenceIds: [UUID], claimIds: ['claim-verdict'], rounds: 1,
    },
  };
}

function packet(): ContextPacket {
  const artifacts: ContextPacket['artifacts'] = [
    { artifact: artifact('BULL_CASE', 'artifact-bull'), roles: ['ACTIVE_BULL_CASE' as const], sourceRefs: [{ role: 'ACTIVE_BULL_CASE' as const, source: 'ACTIVE' as const, ref: { kind: 'BULL_CASE' as const, artifactId: 'artifact-bull' } }] },
    { artifact: artifact('BEAR_CASE', 'artifact-bear'), roles: ['ACTIVE_BEAR_CASE' as const], sourceRefs: [{ role: 'ACTIVE_BEAR_CASE' as const, source: 'ACTIVE' as const, ref: { kind: 'BEAR_CASE' as const, artifactId: 'artifact-bear' } }] },
    { artifact: artifact('VERDICT', 'artifact-verdict'), roles: ['ACTIVE_VERDICT' as const], sourceRefs: [{ role: 'ACTIVE_VERDICT' as const, source: 'ACTIVE' as const, ref: { kind: 'VERDICT' as const, artifactId: 'artifact-verdict' } }] },
  ];
  return {
    schemaVersion: 1,
    sessionId: 'session-budget', turnId: 'turn-follow-up',
    activeSubjects: [{ ticker: 'BBRI' }, { ticker: 'BMRI' }],
    intent: { command: 'conversation' }, focusTopics: [{ topic: 'valuation' }],
    artifacts,
    userAssertions: [{ kind: 'USER_ASSERTION', id: 'assertion-1', text: 'Saya ingin menjaga margin of safety.', turnId: 'turn-previous' }],
    assumptions: [{ kind: 'ASSUMPTION', id: 'assumption-1', text: 'Horizon investasi lima tahun.', turnId: 'turn-previous' }],
    unresolvedQuestions: [{ kind: 'OPEN_QUESTION', id: 'question-1', text: 'Apakah valuasinya masih masuk akal?', turnId: 'turn-previous' }],
    provenance: {
      sessionId: 'session-budget', turnId: 'turn-follow-up', workingContextVersion: 1, sourceContextSequence: 4,
      sourceRefs: artifacts.flatMap(item => item.sourceRefs),
      selectedArtifactIds: artifacts.map(item => item.artifact.artifactId), diagnostics: [],
    },
  };
}

function render(packetValue: ContextPacket): string {
  return JSON.stringify({
    subjects: packetValue.activeSubjects,
    intent: packetValue.intent,
    focusTopics: packetValue.focusTopics,
    artifacts: packetValue.artifacts,
    userAssertions: packetValue.userAssertions,
    assumptions: packetValue.assumptions,
    unresolvedQuestions: packetValue.unresolvedQuestions,
  });
}

function request(overrides: Partial<Parameters<typeof budgetContext>[0]> = {}) {
  return {
    packet: packet(), render,
    focus: 'generic' as const,
    basePrompt: 'Main Kira system instructions.',
    conversationHistory: '', currentUserMessage: 'jadi menurutmu bagaimana?',
    modelCapabilities: { contextWindowTokens: 4096 },
    reservedOutputTokens: 512, safetyMarginTokens: 64,
    ...overrides,
  };
}

describe('deterministic context budgeting and compaction', () => {
  it('uses the smallest configured fallback window as the safe invocation floor', () => {
    expect(effectiveContextWindowTokens({ contextWindowTokens: 16_384, fallbackContextWindowTokens: [8_192, 12_288] })).toBe(8_192);
  });

  it('uses a deterministic conservative multilingual estimate', () => {
    const english = estimateTextTokens('The valuation remains important for the investment thesis.');
    const indonesian = estimateTextTokens('Risiko valuasi tetap penting untuk tesis investasi.');
    const mixed = estimateTextTokens('ROE 18.4% · growth 12.7% · downside paling berbahaya');

    expect(english).toBe(estimateTextTokens('The valuation remains important for the investment thesis.'));
    expect(indonesian).toBeGreaterThan(0);
    expect(mixed).toBeGreaterThan(indonesian);
  });

  it('accounts for base prompt, history, current user, output reserve, and safety margin', () => {
    const result = budgetContext(request({
      packet: { ...packet(), artifacts: [], provenance: { ...packet().provenance, sourceRefs: [], selectedArtifactIds: [] } },
      basePrompt: '1234567890', conversationHistory: 'history', currentUserMessage: 'question',
      modelCapabilities: { contextWindowTokens: 100 }, reservedOutputTokens: 10, safetyMarginTokens: 5,
    }));

    expect(result.report.availableContextTokens).toBe(
      100 - 10 - 5 - estimateTextTokens('1234567890') - estimateTextTokens('history') - estimateTextTokens('question'),
    );
  });

  it('keeps a packet unchanged when the rendered context fits inclusively', () => {
    const source = packet();
    const available = estimateTextTokens(render(source));
    const result = budgetContext(request({
      modelCapabilities: { contextWindowTokens: available + 512 + 64 + estimateTextTokens('Main Kira system instructions.') + estimateTextTokens('jadi menurutmu bagaimana?') },
    }));

    expect(result.compacted).toBe(false);
    expect(result.finalPacket).toEqual(source);
    expect(result.renderedContext).toBe(render(source));
    expect(result.report.estimatedFinalTokens).toBeLessThanOrEqual(result.report.availableContextTokens);
  });

  it('drops low-priority trust-preserving context before optional artifacts', () => {
    const source = packet();
    const fullTokens = estimateTextTokens(render(source));
    const verdictOnly = { ...source, artifacts: [source.artifacts[2]!], userAssertions: [], assumptions: [], unresolvedQuestions: [] };
    const target = estimateTextTokens(render(verdictOnly));
    const result = budgetContext(request({
      modelCapabilities: { contextWindowTokens: target + 512 + 64 + estimateTextTokens('Main Kira system instructions.') + estimateTextTokens('jadi menurutmu bagaimana?') },
    }));

    expect(fullTokens).toBeGreaterThan(target);
    expect(result.compacted).toBe(true);
    expect(result.finalPacket.activeSubjects).toEqual(source.activeSubjects);
    expect(result.finalPacket.intent).toEqual(source.intent);
    expect(result.finalPacket.artifacts.some(item => item.artifact.kind === 'VERDICT')).toBe(true);
    expect(result.finalPacket.userAssertions.every(item => item.kind === 'USER_ASSERTION')).toBe(true);
    expect(result.actions.map(action => action.code)).toContain('DROP_OPEN_QUESTION');
    expect(result.report.estimatedFinalTokens).toBeLessThanOrEqual(result.report.availableContextTokens);
  });

  it('protects downside artifacts and uses stable action ordering', () => {
    const source = packet();
    const result = budgetContext(request({
      focus: 'downside',
      modelCapabilities: { contextWindowTokens: 560 },
      basePrompt: '', conversationHistory: '', currentUserMessage: '', reservedOutputTokens: 0, safetyMarginTokens: 0,
    }));

    expect(result.finalPacket.artifacts.map(item => item.artifact.kind)).toEqual(['BEAR_CASE', 'VERDICT']);
    expect(result.actions.map(action => action.code)).toEqual([
      'DROP_OPEN_QUESTION', 'DROP_ASSUMPTION', 'DROP_USER_ASSERTION',
      'REDUCE_BULL', 'REDUCE_BEAR', 'REDUCE_VERDICT', 'DROP_BULL',
    ]);
  });

  it('keeps thesis-focused context ahead of unrelated artifacts under pressure', () => {
    const source = packet();
    const result = budgetContext(request({
      focus: 'thesis',
      modelCapabilities: { contextWindowTokens: 560 },
      basePrompt: '', conversationHistory: '', currentUserMessage: '', reservedOutputTokens: 0, safetyMarginTokens: 0,
    }));

    expect(result.finalPacket.artifacts.map(item => item.artifact.kind)).toEqual(['BULL_CASE']);
    expect(result.finalPacket.activeSubjects).toEqual(source.activeSubjects);
  });

  it('fails explicitly when the minimum required semantic unit cannot fit', () => {
    expect(() => budgetContext(request({
      modelCapabilities: { contextWindowTokens: 32 },
      basePrompt: 'very long protected system instruction', currentUserMessage: 'current question',
    }))).toThrow(ContextBudgetError);
  });

  it('is deterministic, schema-valid, and does not mutate the source packet', () => {
    const source = packet();
    const before = structuredClone(source);
    const first = budgetContext(request({ modelCapabilities: { contextWindowTokens: 1000 } }));
    const second = budgetContext(request({ modelCapabilities: { contextWindowTokens: 1000 } }));

    expect(first.finalPacket).toEqual(second.finalPacket);
    expect(first.actions).toEqual(second.actions);
    expect(source).toEqual(before);
    expect(first.report.estimator).toBe('ESTIMATED');
  });
});
