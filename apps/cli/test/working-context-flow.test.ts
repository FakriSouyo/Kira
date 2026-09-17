import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { ConversationEvent } from '@harness/session-core';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';
import { createWorkingContextPublisher } from '../src/repl/workingContext';

/**
 * PR D live flow: `/judge` is the reference integration, conversational Turns
 * publish only lightweight intent, and failed/stopped Turns never promote
 * partial research into session truth.
 */
describe('session working context (PR D)', () => {
  let dir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-wc-flow-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () => loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });
  const contextEvents = (sessionId: string) => db.journal.read(sessionId)
    .flatMap(entry => (entry.payload.type === 'session.context.updated' ? [entry.payload] : []));

  it('publishes the deterministic /judge BBRI state with a resolvable verdict reference', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);

    const sessionId = session.conversation.id;
    const context = await db.workingContext.current(sessionId);
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    const execution = artifacts.executions[0];

    expect(context).toMatchObject({
      sessionId, version: 1, currentIntent: { command: 'judge' },
      activeSubjects: [{ ticker: 'BBRI' }],
      updatedByTurnId: artifacts.turns[0].id,
    });
    // PR F references resolve through the typed artifact store; the old
    // JudgmentStore row remains available independently.
    expect(context?.activeVerdictRef).toEqual({ kind: 'VERDICT', artifactId: `artifact_verdict_${execution.id}` });
    expect(context?.activeBullCaseRef).toEqual({ kind: 'BULL_CASE', artifactId: `artifact_bull_case_${execution.id}` });
    expect(context?.activeBearCaseRef).toEqual({ kind: 'BEAR_CASE', artifactId: `artifact_bear_case_${execution.id}` });
    expect(await db.judgments.getByRun(execution.id)).not.toBeNull();

    // No distinct thesis/risk/summary producer exists, so nothing is invented
    // for those slots.
    expect(context?.activeThesisRef).toBeNull();
    expect(context?.activeRiskAssessmentRef).toBeNull();
    expect(context?.runningSummaryRef).toBeNull();
    // Working context stays reference state: no history, no transcripts.
    expect(Object.keys(context ?? {})).not.toContain('history');
    expect(Object.keys(context ?? {})).not.toContain('messages');
    await session.close();
  });

  it('writes exactly one reference-only audit event per committed version', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    const sessionId = session.conversation.id;

    const events = contextEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId, turnId: expect.any(String), oldVersion: 0, newVersion: 1 });
    expect(events[0].sourceSequence).toBeGreaterThan(0);
    // The journal keeps references only; the payload lives in the version store.
    expect(Object.keys(events[0])).not.toContain('payload');
    expect(Object.keys(events[0])).not.toContain('activeSubjects');

    // Exactly one version was committed for the one settled Turn.
    expect((await db.workingContext.history(sessionId)).map(version => version.version)).toEqual([1]);
    await session.close();
  });

  it('publishes only intent for a conversational Turn with zero Executions', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    await session.handleNaturalLanguage('apa risikonya?');
    const sessionId = session.conversation.id;

    const context = await db.workingContext.current(sessionId);
    expect(context).toMatchObject({ version: 2, currentIntent: { command: 'conversation' } });
    // The subject stays relevant across the follow-up.
    expect(context?.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect(context?.activeVerdictRef).toEqual({ kind: 'VERDICT', artifactId: expect.stringMatching(/^artifact_verdict_run_/) });

    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    const conversationTurn = artifacts.turns.find(turn => turn.command === 'conversation')!;
    // No Execution was fabricated for the conversational Turn.
    expect(artifacts.executions.some(execution => execution.turnId === conversationTurn.id)).toBe(false);
    expect(artifacts.executions).toHaveLength(1);
    expect(context?.updatedByTurnId).toBe(conversationTurn.id);
    await session.close();
  });

  it('does not publish research state for a failed Turn', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await expect(session.commands.get('judge')!(['ZZZZ'])).rejects.toThrow();

    const sessionId = session.conversation.id;
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    expect(artifacts.turns[0].status).toBe('failed');
    expect(await db.workingContext.current(sessionId)).toBeNull();
    expect(contextEvents(sessionId)).toEqual([]);
    await session.close();
  });

  it('does not publish research state for a cancelled Turn', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    const controller = new AbortController();
    const context = session.context;
    const analyze = context.bull.analyze.bind(context.bull);
    vi.spyOn(context.bull, 'analyze').mockImplementation(async (args) => {
      const result = await analyze(args);
      controller.abort(new DOMException('Stopped by user', 'AbortError'));
      return result;
    });

    await expect(session.commands.get('judge')!(['BBRI'], { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });

    const sessionId = session.conversation.id;
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    expect(artifacts.turns[0].status).toBe('stopped');
    expect(artifacts.executions[0].status).toBe('cancelled');
    expect(await db.workingContext.current(sessionId)).toBeNull();
    await session.close();
  });

  it('recovers the committed context after a process restart with no in-memory state', async () => {
    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    const sessionId = session.conversation.id;
    const before = await db.workingContext.current(sessionId);
    await session.close();
    db.raw.close();

    db = openDb({ homeDir: dir });
    session = await createHarnessSession(db, config(), { write: () => {} });
    expect(session.conversation.id).toBe(sessionId);
    const after = await db.workingContext.current(sessionId);
    expect(after).toEqual(before);
    expect(after?.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect(after?.currentIntent).toEqual({ command: 'judge' });
    await session.close();
  });

  it('rejects a late writer instead of overwriting state published by a newer Turn', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.recordLocalInput('/help');
    await session.commands.get('judge')!(['BBRI']);
    await session.handleNaturalLanguage('apa risikonya?');
    const sessionId = session.conversation.id;
    const observed = await db.workingContext.current(sessionId);
    expect(observed?.version).toBe(3);

    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    const judgeTurn = artifacts.turns.find(turn => turn.command === 'judge')!;
    const publisher = createWorkingContextPublisher({ db, append: () => undefined });

    // Another Turn settles first (v4), while this writer still holds the v3 read.
    await db.workingContext.commit({
      sessionId, expectedVersion: 3, sourceSequence: db.journal.lastSequence(sessionId),
      updatedByTurnId: judgeTurn.id, patch: { currentIntent: { command: 'screen' } },
    });
    vi.spyOn(db.workingContext, 'current').mockResolvedValue(observed);

    const result = await publisher.publishAfterSettledTurn({ sessionId, turnId: judgeTurn.id, artifacts });

    expect(result).toEqual({ status: 'stale', version: 3 });
    vi.restoreAllMocks();
    const current = await db.workingContext.current(sessionId);
    expect(current).toMatchObject({ version: 4, currentIntent: { command: 'screen' } });
    expect((await db.workingContext.history(sessionId)).map(version => version.version)).toEqual([1, 2, 3, 4]);
    await session.close();
  });

  it('rejects an older Turn that settles after a later Turn', async () => {
    const sessionRecord = await db.sessions.createSession({
      sessionId: 'conversation_turn_order', title: 'Turn order', provider: 'openai', model: 'mock', reasoningMode: 'usual',
    });
    const first = await db.sessions.createTurn({ sessionId: sessionRecord.id, input: 'first', command: 'conversation' });
    const firstStarted = db.journal.append(sessionRecord.id, {
      type: 'turn.started', id: first.id, turnId: first.id, correlationId: first.id,
    });
    const second = await db.sessions.createTurn({ sessionId: sessionRecord.id, input: 'second', command: 'help' });
    const secondStarted = db.journal.append(sessionRecord.id, {
      type: 'turn.started', id: second.id, turnId: second.id, correlationId: second.id,
    });
    expect(firstStarted.sequence).toBeLessThan(secondStarted.sequence);

    // T2 settles first even though T1 was accepted first.
    await db.sessions.settleTurn(second.id, 'completed');
    await db.sessions.settleTurn(first.id, 'completed');
    const artifacts = await db.sessions.getSessionArtifacts(sessionRecord.id);
    const publisher = createWorkingContextPublisher({
      db,
      append: payload => db.journal.append(sessionRecord.id, payload),
    });

    const secondResult = await publisher.publishAfterSettledTurn({
      sessionId: sessionRecord.id, turnId: second.id, artifacts,
    });
    expect(secondResult).toEqual({ status: 'committed', version: 1 });
    expect((await db.workingContext.current(sessionRecord.id))?.currentIntent).toEqual({ command: 'help' });

    const firstResult = await publisher.publishAfterSettledTurn({
      sessionId: sessionRecord.id, turnId: first.id, artifacts,
    });
    expect(firstResult).toEqual({ status: 'stale', version: 1 });
    expect((await db.workingContext.current(sessionRecord.id))?.currentIntent).toEqual({ command: 'help' });
    expect(await db.workingContext.history(sessionRecord.id)).toHaveLength(1);
  });

  it('keeps the durable version when the audit append fails and repairs it on restart', async () => {
    const journal = db.journal;
    const original = journal.append.bind(journal);
    vi.spyOn(journal, 'append').mockImplementation((sessionId: string, payload: ConversationEvent) => {
      if (payload.type === 'session.context.updated') throw new Error('journal append failed');
      return original(sessionId, payload);
    });

    let session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    const sessionId = session.conversation.id;

    // The command still succeeded and the version is committed; only the audit
    // append is missing, so recovery can tell the version is already published.
    expect((await db.workingContext.current(sessionId))?.version).toBe(1);
    expect(contextEvents(sessionId)).toEqual([]);
    await session.close();

    vi.restoreAllMocks();
    db.raw.close();
    db = openDb({ homeDir: dir });
    session = await createHarnessSession(db, config(), { write: () => {} });

    const events = contextEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId, oldVersion: 0, newVersion: 1 });
    // The context event never creates a transcript block.
    expect(session.conversation.blocks.filter(block => block.id.startsWith('context_'))).toEqual([]);
    await session.close();
  });

  it('does not change model prompt behavior', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    const respond = vi.spyOn(session.context.mainAgent, 'respond');

    await session.handleNaturalLanguage('apa risikonya?');

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0][0]).toBe('apa risikonya?');
    // Working context is not injected into the model invocation yet.
    expect(JSON.stringify(respond.mock.calls[0])).not.toContain('activeSubjects');
    await session.close();
  });

  it('publishes intent only for a locally handled TTY command', async () => {
    const session = await createHarnessSession(db, config(), { write: () => {} });
    await session.recordLocalInput('/help');
    const sessionId = session.conversation.id;

    const context = await db.workingContext.current(sessionId);
    expect(context).toMatchObject({ version: 1, currentIntent: { command: 'help' }, activeSubjects: [] });
    expect((await db.sessions.getSessionArtifacts(sessionId)).executions).toEqual([]);
    await session.close();
  });
});
