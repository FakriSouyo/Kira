import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkingContextPatch,
  type ArtifactStore,
  type SessionWorkingContext,
  type WorkingContextStore,
} from '@harness/session-core';
import {
  type ContextSnapshot,
  type ContextSnapshotStore,
} from '@harness/context';
import { renderContextPacket } from '@harness/orchestrator';
import {
  createConversationContextCoordinator,
  type ConversationContextBudgetOptions,
} from '../src/index.js';

const BUDGET_OPTIONS: ConversationContextBudgetOptions = {
  modelCapabilities: { contextWindowTokens: 4096 },
  reservedOutputTokens: 128,
  safetyMarginTokens: 64,
};

function currentWorkingContext(overrides: Partial<SessionWorkingContext> = {}): SessionWorkingContext {
  return {
    ...applyWorkingContextPatch(null, {
      sessionId: 'session-1',
      sourceSequence: 1,
      updatedByTurnId: 'turn-1',
      updatedAt: '2026-09-24T00:00:00.000Z',
      patch: {
        activeSubjects: [{ ticker: 'BMRI' }],
        userAssertions: [{
          kind: 'USER_ASSERTION',
          id: 'assertion-1',
          text: 'The user is comparing long-term downside risks.',
          turnId: 'turn-1',
        }],
      },
    }),
    ...overrides,
  };
}

function makeStores(workingContext: SessionWorkingContext | null) {
  const queries: Array<{
    sessionId: string;
    subjects: string[];
    allowedKinds: Array<'BULL_CASE' | 'BEAR_CASE' | 'VERDICT'>;
    focus: 'generic' | 'downside' | 'thesis' | 'bull' | 'bear';
  }> = [];
  const persisted: ContextSnapshot[] = [];
  const current = vi.fn(async () => workingContext);
  const workingContextStore = { current } as unknown as WorkingContextStore;
  const listByQuery = vi.fn(async (query: (typeof queries)[number]) => {
    queries.push(query);
    return [];
  });
  const artifactStore = { listByQuery } as unknown as ArtifactStore;
  const save = vi.fn(async (snapshot: ContextSnapshot) => {
    persisted.push(snapshot);
    return snapshot;
  });
  const contextSnapshotStore = { save, getById: async () => null } as ContextSnapshotStore;
  return {
    stores: {
      workingContext: workingContextStore,
      artifacts: artifactStore,
      contextSnapshots: contextSnapshotStore,
    },
    queries,
    persisted,
    current,
    listByQuery,
    save,
  };
}

describe('host-neutral conversation context coordinator', () => {
  it('returns null without a WorkingContext and does not persist a snapshot', async () => {
    const harness = makeStores(null);
    const coordinator = createConversationContextCoordinator(harness.stores, BUDGET_OPTIONS);

    await expect(coordinator.prepare({
      sessionId: 'session-1',
      turnId: 'turn-2',
      message: 'halo',
    })).resolves.toBeNull();

    expect(harness.save).not.toHaveBeenCalled();
  });

  it('persists and returns the post-budget snapshot and its rendered packet', async () => {
    const harness = makeStores(currentWorkingContext());
    const coordinator = createConversationContextCoordinator(harness.stores, BUDGET_OPTIONS);

    const prepared = await coordinator.prepare({
      sessionId: 'session-1',
      turnId: 'turn-2',
      message: 'bagaimana menurutmu?',
    });

    expect(prepared).not.toBeNull();
    expect(harness.save).toHaveBeenCalledOnce();
    expect(harness.persisted[0]).toBe(prepared!.snapshot);
    expect(prepared!.packet).toBe(prepared!.snapshot.packet);
    expect(prepared!.rendered).toBe(renderContextPacket(prepared!.snapshot.packet));
    expect(prepared!.diagnostics.budget.conversationHistoryTokens).toBe(0);
  });

  it('keeps explicit focused retrieval scoped to the supplied Session and focus kinds', async () => {
    const harness = makeStores(currentWorkingContext());
    const coordinator = createConversationContextCoordinator(harness.stores, BUDGET_OPTIONS);

    const prepared = await coordinator.prepare({
      sessionId: 'session-1',
      turnId: 'turn-2',
      message: 'Apa downside BBRI?',
    });

    expect(prepared?.focus).toBe('downside');
    expect(harness.listByQuery).toHaveBeenCalledOnce();
    expect(harness.queries).toEqual([{
      sessionId: 'session-1',
      subjects: ['BBRI'],
      allowedKinds: ['BEAR_CASE', 'VERDICT'],
      focus: 'downside',
    }]);
    expect(harness.persisted).toHaveLength(1);
  });

  it('does not persist a snapshot if context budgeting fails', async () => {
    const harness = makeStores(currentWorkingContext());
    const coordinator = createConversationContextCoordinator(harness.stores, {
      modelCapabilities: { contextWindowTokens: 16 },
      reservedOutputTokens: 16,
      safetyMarginTokens: 0,
    });

    await expect(coordinator.prepare({
      sessionId: 'session-1',
      turnId: 'turn-2',
      message: 'downside BBRI',
    })).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });

    expect(harness.save).not.toHaveBeenCalled();
  });
});
