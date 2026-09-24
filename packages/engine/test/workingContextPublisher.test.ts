import { describe, expect, it, vi } from 'vitest';
import type { JudgmentStore } from '@harness/execution';
import {
  deriveWorkingContextPatch,
  StaleWorkingContextError,
  type ArtifactStore,
  type ConversationEntry,
  type ConversationEvent,
  type ResearchExecution,
  type ResearchSessionArtifacts,
  type ResearchTurn,
  type SessionWorkingContext,
  type WorkingContextStore,
} from '@harness/session-core';
import type { ArtifactEnvelope, DurableArtifactRef } from '@harness/schemas';
import { createWorkingContextPublisher } from '../src/index.js';

const SESSION_ID = 'session-1';
const TURN_ID = 'turn-1';
const CREATED_AT = '2026-09-24T00:00:00.000Z';

function turn(overrides: Partial<ResearchTurn> = {}): ResearchTurn {
  return {
    id: TURN_ID,
    sessionId: SESSION_ID,
    runId: null,
    input: 'help',
    command: 'help',
    status: 'completed',
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
    ...overrides,
  };
}

function execution(id: string, overrides: Partial<ResearchExecution> = {}): ResearchExecution {
  return {
    id,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    attempt: 1,
    ticker: 'BBRI',
    command: 'judge',
    status: 'completed',
    executionTime: 1,
    error: null,
    createdAt: CREATED_AT,
    completedAt: CREATED_AT,
    resumeGeneration: 0,
    ...overrides,
  };
}

function context(overrides: Partial<SessionWorkingContext> = {}): SessionWorkingContext {
  return {
    sessionId: SESSION_ID,
    version: 1,
    sourceSequence: 17,
    activeSubjects: [],
    currentIntent: null,
    focusTopics: [],
    activeThesisRef: null,
    activeVerdictRef: null,
    activeBullCaseRef: null,
    activeBearCaseRef: null,
    activeRiskAssessmentRef: null,
    pinnedArtifactRefs: [],
    unresolvedQuestions: [],
    userAssertions: [],
    assumptions: [],
    runningSummaryRef: null,
    updatedByTurnId: TURN_ID,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function acceptanceEntry(params: { sequence?: number; id?: string; turnId?: string } = {}): ConversationEntry {
  const id = params.id ?? TURN_ID;
  const turnId = params.turnId ?? TURN_ID;
  return {
    id: `event-${params.sequence ?? 17}`,
    sessionId: SESSION_ID,
    sequence: params.sequence ?? 17,
    createdAt: CREATED_AT,
    payload: { type: 'turn.started', id, turnId },
  };
}

function contextEntry(version: number): ConversationEntry {
  return {
    id: `event-context-${version}`,
    sessionId: SESSION_ID,
    sequence: version + 20,
    createdAt: CREATED_AT,
    payload: {
      type: 'session.context.updated',
      id: `context_${SESSION_ID}_v${version}`,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      oldVersion: version - 1,
      newVersion: version,
      sourceSequence: version + 10,
    },
  };
}

function artifact(kind: ArtifactEnvelope['kind'], artifactId: string): ArtifactEnvelope {
  return {
    artifactId,
    kind,
    schemaVersion: 1,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    executionId: 'judge-1',
    ticker: 'BBRI',
    payload: {},
    createdAt: CREATED_AT,
  } as ArtifactEnvelope;
}

interface HarnessOptions {
  turn?: Partial<ResearchTurn> | null;
  executions?: ResearchExecution[];
  current?: SessionWorkingContext | null;
  history?: SessionWorkingContext[];
  journal?: readonly ConversationEntry[];
  typedArtifacts?: ArtifactEnvelope[];
  legacyJudgment?: unknown;
  commitError?: unknown;
  commitResult?: SessionWorkingContext;
  appendError?: unknown;
}

function makeHarness(options: HarnessOptions = {}) {
  const targetTurn = options.turn === null ? undefined : turn(options.turn);
  const sessionArtifacts = {
    turns: targetTurn ? [targetTurn] : [],
    executions: options.executions ?? [],
  } as ResearchSessionArtifacts;
  const current = options.current ?? null;
  const currentStore = vi.fn(async () => current);
  const historyStore = vi.fn(async () => options.history ?? []);
  const commitStore = vi.fn(async (params: Parameters<WorkingContextStore['commit']>[0]) => {
    if (options.commitError) throw options.commitError;
    return options.commitResult ?? context({
      sessionId: params.sessionId,
      version: (current?.version ?? 0) + 1,
      sourceSequence: params.sourceSequence,
      updatedByTurnId: params.updatedByTurnId,
      currentIntent: { command: targetTurn?.command ?? 'help' },
    });
  });
  const workingContext = { current: currentStore, history: historyStore, commit: commitStore } as unknown as WorkingContextStore;
  const getByExecution = vi.fn(async (_executionId: string) => options.typedArtifacts ?? []);
  const artifacts = { getByExecution } as unknown as ArtifactStore;
  const getByRun = vi.fn(async (_runId: string) => options.legacyJudgment ?? null);
  const judgments = { getByRun } as unknown as JudgmentStore;
  const readJournal = vi.fn((_sessionId: string) => options.journal ?? [acceptanceEntry()]);
  const appended: ConversationEvent[] = [];
  const appendAuditEvent = vi.fn((payload: ConversationEvent) => {
    if (options.appendError) throw options.appendError;
    appended.push(payload);
  });
  const publisher = createWorkingContextPublisher({
    workingContext,
    artifacts,
    judgments,
    readJournal,
    appendAuditEvent,
  });

  return {
    publisher,
    sessionArtifacts,
    currentStore,
    historyStore,
    commitStore,
    getByExecution,
    getByRun,
    readJournal,
    appendAuditEvent,
    appended,
  };
}

describe('host-neutral WorkingContext publisher', () => {
  it('skips missing and non-completed Turns', async () => {
    for (const options of [
      { turn: null },
      { turn: { status: 'running' as const } },
      { turn: { status: 'failed' as const } },
      { turn: { status: 'stopped' as const } },
    ]) {
      const harness = makeHarness(options);

      await expect(harness.publisher.publishAfterSettledTurn({
        sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
      })).resolves.toEqual({ status: 'skipped', version: null });
      expect(harness.currentStore).not.toHaveBeenCalled();
      expect(harness.commitStore).not.toHaveBeenCalled();
      expect(harness.appendAuditEvent).not.toHaveBeenCalled();
    }
  });

  it('skips the new Session lifecycle command', async () => {
    const harness = makeHarness({ turn: { command: 'new' } });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).resolves.toEqual({ status: 'skipped', version: null });
    expect(harness.currentStore).not.toHaveBeenCalled();
    expect(harness.commitStore).not.toHaveBeenCalled();
  });

  it('uses only completed Executions for this Turn and preserves their order', async () => {
    const executions = [
      execution('judge-completed'),
      execution('judge-failed', { status: 'failed', ticker: 'FAILED' }),
      execution('judge-cancelled', { status: 'cancelled', ticker: 'CANCELLED' }),
      execution('judge-running', { status: 'running', ticker: 'RUNNING' }),
      execution('judge-interrupted', { status: 'interrupted', ticker: 'INTERRUPTED' }),
      execution('other-turn', { turnId: 'turn-other', ticker: 'OTHER' }),
      execution('screen-completed', { command: 'screen', ticker: 'BMRI' }),
    ];
    const harness = makeHarness({ turn: { command: 'judge' }, executions, legacyJudgment: {} });

    await harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    });

    expect(harness.getByExecution.mock.calls.map(([id]) => id)).toEqual(['judge-completed']);
    expect(harness.getByRun.mock.calls.map(([id]) => id)).toEqual(['judge-completed']);
    expect(harness.commitStore).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        currentIntent: { command: 'judge' },
        activeSubjects: [{ ticker: 'BMRI' }],
      }),
    }));
    expect(harness.commitStore.mock.calls[0]?.[0].patch.activeVerdictRef).toBeUndefined();
  });

  it('prefers typed Artifact refs and passes them through existing patch derivation', async () => {
    const executions = [execution('judge-1')];
    const typedArtifacts = [
      artifact('BULL_CASE', 'artifact-bull'),
      artifact('BEAR_CASE', 'artifact-bear'),
      artifact('VERDICT', 'artifact-verdict'),
    ];
    const harness = makeHarness({ turn: { command: 'judge' }, executions, typedArtifacts, legacyJudgment: {} });

    await harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    });

    expect(harness.getByExecution).toHaveBeenCalledExactlyOnceWith('judge-1');
    expect(harness.getByRun).not.toHaveBeenCalled();
    const artifactRefs: DurableArtifactRef[] = typedArtifacts.map(({ kind, artifactId }) => ({ kind, artifactId }));
    expect(harness.commitStore.mock.calls[0]?.[0].patch).toEqual(deriveWorkingContextPatch({
      command: 'judge',
      executions: [{ executionId: 'judge-1', ticker: 'BBRI', command: 'judge' }],
      judgedExecutionIds: [],
      artifactRefs,
    }));
  });

  it('uses legacy Judgment lookup only when a completed Judge Execution has no typed Artifacts', async () => {
    const executions = [execution('judge-1')];
    const harness = makeHarness({ turn: { command: 'judge' }, executions, legacyJudgment: {} });

    await harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    });

    expect(harness.getByExecution).toHaveBeenCalledExactlyOnceWith('judge-1');
    expect(harness.getByRun).toHaveBeenCalledExactlyOnceWith('judge-1');
    expect(harness.commitStore.mock.calls[0]?.[0].patch).toEqual(deriveWorkingContextPatch({
      command: 'judge',
      executions: [{ executionId: 'judge-1', ticker: 'BBRI', command: 'judge' }],
      judgedExecutionIds: ['judge-1'],
    }));
    expect(harness.commitStore.mock.calls[0]?.[0].patch.activeVerdictRef).toEqual({
      kind: 'judgment', executionId: 'judge-1',
    });
  });

  it('suppresses no-op patches without reading the journal, committing, or appending', async () => {
    const harness = makeHarness({
      current: context({ version: 7, currentIntent: { command: 'help' } }),
    });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).resolves.toEqual({ status: 'skipped', version: 7 });
    expect(harness.readJournal).not.toHaveBeenCalled();
    expect(harness.commitStore).not.toHaveBeenCalled();
    expect(harness.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('skips publication when there is no canonical turn.started acceptance watermark', async () => {
    const harness = makeHarness({
      current: context({ version: 2 }),
      journal: [
        acceptanceEntry({ sequence: 17, id: 'wrong-id', turnId: TURN_ID }),
        acceptanceEntry({ sequence: 99, id: 'other-turn', turnId: 'other-turn' }),
      ],
    });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).resolves.toEqual({ status: 'skipped', version: 2 });
    expect(harness.commitStore).not.toHaveBeenCalled();
    expect(harness.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('uses the exact turn.started sequence as sourceSequence', async () => {
    const harness = makeHarness({
      journal: [acceptanceEntry({ sequence: 17 }), acceptanceEntry({ sequence: 99, id: 'later', turnId: 'later' })],
    });

    await harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    });

    expect(harness.commitStore.mock.calls[0]?.[0].sourceSequence).toBe(17);
  });

  it('maps StaleWorkingContextError to stale using the observed version', async () => {
    const stale = new StaleWorkingContextError('STALE_CONTEXT_VERSION', SESSION_ID, 'another writer committed');
    const harness = makeHarness({ current: context({ version: 4 }), commitError: stale });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).resolves.toEqual({ status: 'stale', version: 4 });
    expect(harness.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('propagates WorkingContext commit errors other than StaleWorkingContextError', async () => {
    const failure = new Error('disk unavailable');
    const harness = makeHarness({ commitError: failure });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).rejects.toBe(failure);
    expect(harness.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('keeps the committed version when audit append fails', async () => {
    const committed = context({ version: 8, sourceSequence: 17 });
    const harness = makeHarness({ commitResult: committed, appendError: new Error('journal unavailable') });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).resolves.toEqual({ status: 'audit_failed', version: 8 });
    expect(harness.commitStore).toHaveBeenCalledOnce();
    expect(harness.appendAuditEvent).toHaveBeenCalledOnce();
  });

  it('emits the exact reference-only session.context.updated event after commit', async () => {
    const committed = context({ version: 8, sourceSequence: 17 });
    const harness = makeHarness({ commitResult: committed });

    await expect(harness.publisher.publishAfterSettledTurn({
      sessionId: SESSION_ID, turnId: TURN_ID, artifacts: harness.sessionArtifacts,
    })).resolves.toEqual({ status: 'committed', version: 8 });
    expect(harness.appendAuditEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'session.context.updated',
      id: `context_${SESSION_ID}_v8`,
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      oldVersion: 7,
      newVersion: 8,
      sourceSequence: 17,
    });
  });

  it('repairs missing audit events from durable WorkingContext history', async () => {
    const history = [
      context({ version: 1, sourceSequence: 17 }),
      context({ version: 2, sourceSequence: 22 }),
    ];
    const harness = makeHarness({ history, journal: [] });

    await expect(harness.publisher.reconcileJournal(SESSION_ID)).resolves.toBe(2);
    expect(harness.appendAuditEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: 'session.context.updated', id: `context_${SESSION_ID}_v1`, sessionId: SESSION_ID, turnId: TURN_ID, oldVersion: 0, newVersion: 1, sourceSequence: 17 },
      { type: 'session.context.updated', id: `context_${SESSION_ID}_v2`, sessionId: SESSION_ID, turnId: TURN_ID, oldVersion: 1, newVersion: 2, sourceSequence: 22 },
    ]);
  });

  it('skips reconciliation versions already recorded in the journal', async () => {
    const harness = makeHarness({
      history: [context({ version: 1 }), context({ version: 2 })],
      journal: [contextEntry(1)],
    });

    await expect(harness.publisher.reconcileJournal(SESSION_ID)).resolves.toBe(1);
    expect(harness.appendAuditEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ newVersion: 2 }));
  });

  it('does not fabricate reconciliation events for unattributed versions', async () => {
    const harness = makeHarness({ history: [context({ version: 1, updatedByTurnId: null })], journal: [] });

    await expect(harness.publisher.reconcileJournal(SESSION_ID)).resolves.toBe(0);
    expect(harness.appendAuditEvent).not.toHaveBeenCalled();
  });

  it('stops reconciliation after append failure and returns the repaired count', async () => {
    const harness = makeHarness({
      history: [context({ version: 1 }), context({ version: 2 }), context({ version: 3 })],
      journal: [],
    });
    harness.appendAuditEvent
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => { throw new Error('journal unavailable'); });

    await expect(harness.publisher.reconcileJournal(SESSION_ID)).resolves.toBe(1);
    expect(harness.appendAuditEvent).toHaveBeenCalledTimes(2);
  });
});
