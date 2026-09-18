import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { StaleWorkingContextError } from '@harness/session-core';

/**
 * PR D storage guarantees: versioned working context behind the storage boundary,
 * compare-and-set commits, historical readability, and additive migration.
 */
describe('working-context store', () => {
  let dir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-working-context-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedSession(sessionId = 'conversation_wc') {
    await db.sessions.createSession({ sessionId, title: 'WC', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ sessionId, input: '/judge BBRI', command: 'judge' });
    return { sessionId, turn };
  }

  it('has no committed version for a new session', async () => {
    await seedSession();
    expect(await db.workingContext.current('conversation_wc')).toBeNull();
    expect(await db.workingContext.history('conversation_wc')).toEqual([]);
    expect(await db.workingContext.at('conversation_wc', 1)).toBeNull();
  });

  it('commits monotonically increasing versions with their source sequence', async () => {
    const { sessionId, turn } = await seedSession();
    const first = await db.workingContext.commit({
      sessionId, expectedVersion: 0, sourceSequence: 4, updatedByTurnId: turn.id,
      patch: { currentIntent: { command: 'judge' }, activeSubjects: [{ ticker: 'BBRI' }] },
      at: '2026-09-17T00:00:00.000Z',
    });
    const second = await db.workingContext.commit({
      sessionId, expectedVersion: 1, sourceSequence: 9, updatedByTurnId: turn.id,
      patch: { currentIntent: { command: 'conversation' } },
      at: '2026-09-17T00:01:00.000Z',
    });

    expect(first).toMatchObject({ version: 1, sourceSequence: 4, updatedByTurnId: turn.id, updatedAt: '2026-09-17T00:00:00.000Z' });
    expect(second).toMatchObject({ version: 2, sourceSequence: 9, currentIntent: { command: 'conversation' } });
    // Omitted fields survive the second commit.
    expect(second.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect((await db.workingContext.current(sessionId))?.version).toBe(2);
  });

  it('keeps historical versions readable and returns them ascending', async () => {
    const { sessionId, turn } = await seedSession();
    for (const [index, ticker] of (['BBCA', 'BBRI', 'BMRI'] as const).entries()) {
      await db.workingContext.commit({
        sessionId, expectedVersion: index, sourceSequence: index + 1, updatedByTurnId: turn.id,
        patch: { activeSubjects: [{ ticker }] },
      });
    }
    const history = await db.workingContext.history(sessionId);
    expect(history.map(version => version.version)).toEqual([1, 2, 3]);
    expect(history.map(version => version.activeSubjects[0].ticker)).toEqual(['BBCA', 'BBRI', 'BMRI']);
    expect((await db.workingContext.at(sessionId, 2))?.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect((await db.workingContext.at(sessionId, 99))).toBeNull();
    const recent = await db.workingContext.history(sessionId, 2);
    expect(recent.map(version => version.version)).toEqual([2, 3]);
  });

  it('rejects a stale expected version without writing anything', async () => {
    const { sessionId, turn } = await seedSession();
    await db.workingContext.commit({ sessionId, expectedVersion: 0, sourceSequence: 1, updatedByTurnId: turn.id, patch: { currentIntent: { command: 'judge' } } });
    // An older Turn settling late must not overwrite newer state.
    await expect(db.workingContext.commit({
      sessionId, expectedVersion: 0, sourceSequence: 99, updatedByTurnId: turn.id,
      patch: { currentIntent: { command: 'conversation' } },
    })).rejects.toMatchObject({ code: 'STALE_WORKING_CONTEXT', conflict: 'STALE_CONTEXT_VERSION' });

    const current = await db.workingContext.current(sessionId);
    expect(current?.version).toBe(1);
    expect(current?.currentIntent).toEqual({ command: 'judge' });
    expect(await db.workingContext.history(sessionId)).toHaveLength(1);
  });

  it('rejects a writer that observed an older journal prefix', async () => {
    const { sessionId, turn } = await seedSession();
    await db.workingContext.commit({ sessionId, expectedVersion: 0, sourceSequence: 10, updatedByTurnId: turn.id, patch: { currentIntent: { command: 'judge' } } });
    await expect(db.workingContext.commit({
      sessionId, expectedVersion: 1, sourceSequence: 9, updatedByTurnId: turn.id,
      patch: { currentIntent: { command: 'conversation' } },
    })).rejects.toMatchObject({ conflict: 'STALE_SOURCE_SEQUENCE' });
    expect((await db.workingContext.current(sessionId))?.version).toBe(1);
  });

  it('lets only one of two concurrent commits of the same version win', async () => {
    const { sessionId, turn } = await seedSession();
    const [first, second] = await Promise.allSettled([
      db.workingContext.commit({ sessionId, expectedVersion: 0, sourceSequence: 5, updatedByTurnId: turn.id, patch: { currentIntent: { command: 'judge' } } }),
      db.workingContext.commit({ sessionId, expectedVersion: 0, sourceSequence: 6, updatedByTurnId: turn.id, patch: { currentIntent: { command: 'conversation' } } }),
    ]);
    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = [first, second].find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StaleWorkingContextError);
    expect(await db.workingContext.history(sessionId)).toHaveLength(1);
  });

  it('isolates sessions from each other', async () => {
    await seedSession('conversation_a');
    await seedSession('conversation_b');
    const turnA = (await db.sessions.getSessionArtifacts('conversation_a')).turns[0];
    const turnB = (await db.sessions.getSessionArtifacts('conversation_b')).turns[0];
    await db.workingContext.commit({ sessionId: 'conversation_a', expectedVersion: 0, sourceSequence: 1, updatedByTurnId: turnA.id, patch: { activeSubjects: [{ ticker: 'BBCA' }] } });
    await db.workingContext.commit({ sessionId: 'conversation_b', expectedVersion: 0, sourceSequence: 1, updatedByTurnId: turnB.id, patch: { activeSubjects: [{ ticker: 'BBRI' }] } });

    expect((await db.workingContext.current('conversation_a'))?.activeSubjects).toEqual([{ ticker: 'BBCA' }]);
    expect((await db.workingContext.current('conversation_b'))?.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect((await db.workingContext.history('conversation_a')).map(version => version.version)).toEqual([1]);
  });
});