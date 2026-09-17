import { describe, expect, it } from 'vitest';
import {
  applyWorkingContextPatch,
  assertWorkingContextCommit,
  defaultWorkingContext,
  deriveWorkingContextPatch,
  isWorkingContextPatchNoOp,
  StaleWorkingContextError,
  type SessionWorkingContext,
} from '../src/index.js';

const committed = (sessionId: string, overrides: Partial<SessionWorkingContext> = {}): SessionWorkingContext => ({
  ...defaultWorkingContext(sessionId),
  version: 3,
  sourceSequence: 12,
  updatedByTurnId: 'turn_3',
  updatedAt: '2026-09-17T00:00:00.000Z',
  ...overrides,
});

describe('SessionWorkingContext contract', () => {
  it('starts empty and uncommitted', () => {
    const empty = defaultWorkingContext('conversation_1');
    expect(empty).toMatchObject({
      sessionId: 'conversation_1', version: 0, sourceSequence: 0,
      activeSubjects: [], currentIntent: null, focusTopics: [], pinnedArtifactRefs: [],
      unresolvedQuestions: [], userAssertions: [], assumptions: [],
      activeThesisRef: null, activeVerdictRef: null, activeBullCaseRef: null,
      activeBearCaseRef: null, activeRiskAssessmentRef: null, runningSummaryRef: null,
      updatedByTurnId: null, updatedAt: null,
    });
  });

  it('bumps the version and replaces only the published fields', () => {
    const current = committed('conversation_1', { activeSubjects: [{ ticker: 'BBCA' }], pinnedArtifactRefs: [{ kind: 'judgment', executionId: 'run_1' }] });
    const next = applyWorkingContextPatch(current, {
      sessionId: 'conversation_1', sourceSequence: 14, updatedByTurnId: 'turn_4',
      updatedAt: '2026-09-17T01:00:00.000Z', patch: { currentIntent: { command: 'judge' } },
    });
    expect(next.version).toBe(4);
    expect(next.sourceSequence).toBe(14);
    expect(next.updatedByTurnId).toBe('turn_4');
    expect(next.currentIntent).toEqual({ command: 'judge' });
    // Omitted fields keep their committed value.
    expect(next.activeSubjects).toEqual([{ ticker: 'BBCA' }]);
    expect(next.pinnedArtifactRefs).toEqual([{ kind: 'judgment', executionId: 'run_1' }]);
  });

  it('publishes the first version from an uncommitted state', () => {
    const next = applyWorkingContextPatch(null, {
      sessionId: 'conversation_new', sourceSequence: 4, updatedByTurnId: 'turn_1',
      updatedAt: '2026-09-17T02:00:00.000Z', patch: { activeSubjects: [{ ticker: 'BBRI' }] },
    });
    expect(next).toMatchObject({ sessionId: 'conversation_new', version: 1, sourceSequence: 4, updatedByTurnId: 'turn_1' });
    expect(next.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
  });

  it('clears a reference when a patch publishes null explicitly', () => {
    const current = committed('conversation_1', { activeVerdictRef: { kind: 'judgment', executionId: 'run_1' } });
    const next = applyWorkingContextPatch(current, {
      sessionId: 'conversation_1', sourceSequence: 15, updatedByTurnId: 'turn_5', updatedAt: null,
      patch: { activeVerdictRef: null },
    });
    expect(next.activeVerdictRef).toBeNull();
  });

  it('detects no-op patches so identical turns do not create versions', () => {
    const current = committed('conversation_1', { activeSubjects: [{ ticker: 'BBRI' }], currentIntent: { command: 'judge' } });
    expect(isWorkingContextPatchNoOp(current, { currentIntent: { command: 'judge' }, activeSubjects: [{ ticker: 'BBRI' }] })).toBe(true);
    expect(isWorkingContextPatchNoOp(current, { currentIntent: { command: 'conversation' } })).toBe(false);
    expect(isWorkingContextPatchNoOp(current, {})).toBe(true);
    expect(isWorkingContextPatchNoOp(null, {})).toBe(true);
    expect(isWorkingContextPatchNoOp(null, { activeSubjects: [{ ticker: 'BBRI' }] })).toBe(false);
  });

  it('rejects a stale expected version', () => {
    const current = committed('conversation_1');
    expect(() => assertWorkingContextCommit(current, { sessionId: 'conversation_1', expectedVersion: 3, sourceSequence: 12 })).not.toThrow();
    try {
      assertWorkingContextCommit(current, { sessionId: 'conversation_1', expectedVersion: 2, sourceSequence: 13 });
      throw new Error('expected a stale version rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(StaleWorkingContextError);
      expect((error as StaleWorkingContextError).conflict).toBe('STALE_CONTEXT_VERSION');
    }
    // No committed version yet: only expectedVersion 0 is valid.
    expect(() => assertWorkingContextCommit(null, { sessionId: 's', expectedVersion: 1, sourceSequence: 1 })).toThrow(StaleWorkingContextError);
  });

  it('rejects a writer that observed an older journal prefix', () => {
    const current = committed('conversation_1', { sourceSequence: 12 });
    try {
      assertWorkingContextCommit(current, { sessionId: 'conversation_1', expectedVersion: 3, sourceSequence: 11 });
      throw new Error('expected a stale source-sequence rejection');
    } catch (error) {
      expect((error as StaleWorkingContextError).conflict).toBe('STALE_SOURCE_SEQUENCE');
    }
    expect(() => assertWorkingContextCommit(current, { sessionId: 'conversation_1', expectedVersion: 3, sourceSequence: 12 })).not.toThrow();
  });
});

describe('deriveWorkingContextPatch', () => {
  it('publishes only the intent for a conversational Turn with zero Executions', () => {
    const patch = deriveWorkingContextPatch({ command: 'conversation', executions: [], judgedExecutionIds: [] });
    expect(patch).toEqual({ currentIntent: { command: 'conversation' } });
    expect(patch.activeSubjects).toBeUndefined();
    expect(patch.activeVerdictRef).toBeUndefined();
  });

  it('publishes the active subject and a resolvable verdict reference for a judged Turn', () => {
    const patch = deriveWorkingContextPatch({
      command: 'judge',
      executions: [{ executionId: 'run_bbri', ticker: 'BBRI', command: 'judge' }],
      judgedExecutionIds: ['run_bbri'],
    });
    expect(patch).toEqual({
      currentIntent: { command: 'judge' },
      activeSubjects: [{ ticker: 'BBRI' }],
      activeVerdictRef: { kind: 'judgment', executionId: 'run_bbri' },
    });
  });

  it('never invents a verdict reference when no judgment is persisted', () => {
    const patch = deriveWorkingContextPatch({
      command: 'judge',
      executions: [{ executionId: 'run_failed', ticker: 'BBRI', command: 'judge' }],
      judgedExecutionIds: [],
    });
    expect(patch.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect(patch.activeVerdictRef).toBeUndefined();
    // PR F owns thesis/bull/bear/risk artifacts; nothing is fabricated here.
    expect(patch.activeThesisRef).toBeUndefined();
    expect(patch.activeBullCaseRef).toBeUndefined();
    expect(patch.activeBearCaseRef).toBeUndefined();
    expect(patch.activeRiskAssessmentRef).toBeUndefined();
  });

  it('uses the latest completed Execution as the active subject', () => {
    const patch = deriveWorkingContextPatch({
      command: 'judge',
      executions: [
        { executionId: 'run_bbca', ticker: 'BBCA', command: 'judge' },
        { executionId: 'run_bbri', ticker: 'BBRI', command: 'judge' },
      ],
      judgedExecutionIds: ['run_bbca', 'run_bbri'],
    });
    expect(patch.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect(patch.activeVerdictRef).toEqual({ kind: 'judgment', executionId: 'run_bbri' });
  });
});

describe('working-context provenance', () => {
  it('labels user state so it can never pass as verified evidence', () => {
    const context = applyWorkingContextPatch(null, {
      sessionId: 'conversation_1', sourceSequence: 3, updatedByTurnId: 'turn_1', updatedAt: '2026-09-17T00:00:00.000Z',
      patch: {
        userAssertions: [{ kind: 'USER_ASSERTION', id: 'assert_1', text: 'menurutku BBRI mahal', turnId: 'turn_1' }],
        assumptions: [{ kind: 'ASSUMPTION', id: 'assumption_1', text: 'margin stays flat', turnId: 'turn_1' }],
        unresolvedQuestions: [{ kind: 'OPEN_QUESTION', id: 'q_1', text: 'why did BBRI fall?', turnId: 'turn_1' }],
      },
    });
    expect(context.userAssertions[0].kind).toBe('USER_ASSERTION');
    expect(context.assumptions[0].kind).toBe('ASSUMPTION');
    expect(context.unresolvedQuestions[0].kind).toBe('OPEN_QUESTION');
    // No evidence-shaped field exists on working-context items.
    expect(Object.keys(context.userAssertions[0])).not.toContain('evidenceIds');
  });
});