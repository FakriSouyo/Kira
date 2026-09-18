import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextPacketFingerprint } from '@harness/context';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { renderContextPacket } from '@harness/orchestrator';
import type { SectorsApi } from '@harness/sectors-api';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';

describe('PR I conversational context integration', () => {
  let db: FinharnessDatabase;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-conversation-context-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function providerSpies(sectors: SectorsApi) {
    const methods: Array<keyof SectorsApi> = [
      'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
      'getForeignFlow', 'getNews', 'getFilings', 'getSentiment', 'screen',
    ];
    return methods.map(method => vi.spyOn(sectors, method));
  }

  it('reuses prior /judge artifacts for a generic follow-up without a provider call or rerun', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    const sectors = providerSpies(session.context.sectors);
    await session.commands.get('judge')!(['BBRI']);
    const providerCallsBeforeFollowUp = sectors.map(spy => spy.mock.calls.length);
    const respond = vi.spyOn(session.context.mainAgent, 'respond');

    await session.handleNaturalLanguage('jadi menurutmu bagaimana?');

    expect(sectors.map(spy => spy.mock.calls.length)).toEqual(providerCallsBeforeFollowUp);
    expect(respond).toHaveBeenCalledWith('jadi menurutmu bagaimana?', expect.objectContaining({
      context: expect.objectContaining({ rendered: expect.stringContaining('VERIFIED RESEARCH ARTIFACTS') }),
    }));

    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    const followUp = artifacts.turns.find(turn => turn.command === 'conversation')!;
    expect(artifacts.executions).toHaveLength(1);
    expect(artifacts.executions[0]?.turnId).not.toBe(followUp.id);

    const snapshotId = artifacts.modelCalls.find(call => call.turnId === followUp.id)?.contextSnapshotId;
    expect(snapshotId).toMatch(/^snapshot_[0-9a-f]{64}$/);
    const snapshot = await db.contextSnapshots.getById(snapshotId!);
    expect(snapshot?.packet.artifacts.map(item => item.artifact.kind)).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ context: { snapshotId } });
    expect(renderContextPacket(snapshot!.packet)).toBe(respond.mock.calls[0]?.[1]?.context?.rendered);
    expect(snapshot?.packet.provenance.workingContextVersion).toBe(1);
    await session.close();
  });

  it('selects downside and thesis context without provider calls or fake thesis artifacts', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    const sectors = providerSpies(session.context.sectors);
    await session.commands.get('judge')!(['BBRI']);
    const providerCallsAfterJudge = sectors.map(spy => spy.mock.calls.length);

    await session.handleNaturalLanguage('downside paling bahayanya apa?');
    await session.handleNaturalLanguage('balik ke thesis BBRI tadi');

    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    const conversationTurns = artifacts.turns.filter(turn => turn.command === 'conversation');
    const calls = artifacts.modelCalls.filter(call => conversationTurns.some(turn => turn.id === call.turnId));
    expect(calls).toHaveLength(2);
    const downsideSnapshot = await db.contextSnapshots.getById(calls[0]!.contextSnapshotId!);
    const thesisSnapshot = await db.contextSnapshots.getById(calls[1]!.contextSnapshotId!);
    expect(downsideSnapshot?.packet.artifacts.map(item => item.artifact.kind)).toEqual(['BEAR_CASE', 'VERDICT']);
    expect(thesisSnapshot?.packet.artifacts.map(item => item.artifact.kind)).toEqual(['BULL_CASE']);
    expect(thesisSnapshot?.packet.artifacts.some(item => item.artifact.kind === 'THESIS')).toBe(false);
    expect(providerCallsAfterJudge).toEqual(sectors.map(spy => spy.mock.calls.length));
    expect(artifacts.executions).toHaveLength(1);
    await session.close();
  });

  it('keeps a context-free conversation unlinked and execution-free', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    const sectors = providerSpies(session.context.sectors);

    await session.handleNaturalLanguage('halo');

    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    const turn = artifacts.turns.find(candidate => candidate.command === 'conversation')!;
    const call = artifacts.modelCalls.find(candidate => candidate.turnId === turn.id)!;
    expect(artifacts.executions).toHaveLength(0);
    expect(call).toMatchObject({ turnId: turn.id, runId: null, stepId: null, contextSnapshotId: null });
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as { count: number }).count).toBe(0);
    expect(sectors.every(spy => spy.mock.calls.length === 0)).toBe(true);
    await session.close();
  });

  it('rebuilds follow-up context from durable refs after restart', async () => {
    let session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    const sessionId = session.conversation.id;
    await session.close();
    db.raw.close();

    db = openDb({ homeDir: dir });
    session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    const sectors = providerSpies(session.context.sectors);
    await session.handleNaturalLanguage('jadi menurutmu bagaimana?');

    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    const turn = artifacts.turns.find(candidate => candidate.command === 'conversation')!;
    const call = artifacts.modelCalls.find(candidate => candidate.turnId === turn.id)!;
    const snapshot = await db.contextSnapshots.getById(call.contextSnapshotId!);
    expect(snapshot?.sessionId).toBe(sessionId);
    expect(snapshot?.packet.artifacts.map(item => item.artifact.kind)).toEqual(['BULL_CASE', 'BEAR_CASE', 'VERDICT']);
    expect(sectors.every(spy => spy.mock.calls.length === 0)).toBe(true);
    await session.close();
  });

  it('does not invoke the model when a required context snapshot cannot be persisted', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true }), { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    vi.spyOn(db.contextSnapshots, 'save').mockRejectedValue(new Error('snapshot unavailable'));
    const respond = vi.spyOn(session.context.mainAgent, 'respond');

    await expect(session.handleNaturalLanguage('jadi menurutmu bagaimana?')).rejects.toThrow('snapshot unavailable');
    expect(respond).not.toHaveBeenCalled();
    await session.close();
  });

  it('snapshots the post-compaction packet and keeps protected downside context', async () => {
    const config = loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });
    config.llm.agent = { ...config.llm.agent, contextWindowTokens: 1100, maxTokens: 64 };
    const session = await createHarnessSession(db, config, { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);

    const current = await db.workingContext.current(session.conversation.id);
    expect(current).not.toBeNull();
    const assertions = Array.from({ length: 12 }, (_, index) => ({
      kind: 'USER_ASSERTION' as const,
      id: `assertion-budget-${index}`,
      text: `User assertion ${index} about the long-term margin of safety and downside sensitivity.`,
      turnId: 'turn-previous',
    }));
    await db.workingContext.commit({
      sessionId: session.conversation.id,
      expectedVersion: current!.version,
      sourceSequence: current!.sourceSequence + 1,
      updatedByTurnId: current!.updatedByTurnId!,
      patch: { userAssertions: assertions },
    });

    const respond = vi.spyOn(session.context.mainAgent, 'respond');
    await session.handleNaturalLanguage('downside paling bahayanya apa?');

    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    const turn = artifacts.turns.find(candidate => candidate.command === 'conversation')!;
    const call = artifacts.modelCalls.find(candidate => candidate.turnId === turn.id)!;
    const snapshot = await db.contextSnapshots.getById(call.contextSnapshotId!);
    expect(snapshot?.packet.userAssertions).toHaveLength(0);
    expect(snapshot?.packet.artifacts.map(item => item.artifact.kind)).toEqual(['BEAR_CASE', 'VERDICT']);
    expect(snapshot?.packet.provenance.workingContextVersion).toBe(2);
    expect(snapshot?.packetFingerprint).toBe(contextPacketFingerprint(snapshot!.packet));
    expect(renderContextPacket(snapshot!.packet)).toBe(respond.mock.calls[0]?.[1]?.context?.rendered);
    await session.close();
  });

  it('fails before snapshot/model invocation when the protected context cannot fit', async () => {
    const config = loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });
    config.llm.agent = { ...config.llm.agent, contextWindowTokens: 128, maxTokens: 64 };
    const session = await createHarnessSession(db, config, { write: () => {} });
    await session.commands.get('judge')!(['BBRI']);
    const respond = vi.spyOn(session.context.mainAgent, 'respond');
    const snapshotsBeforeFollowUp = (db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as { count: number }).count;

    await expect(session.handleNaturalLanguage('jadi menurutmu bagaimana?')).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    expect(respond).not.toHaveBeenCalled();
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as { count: number }).count).toBe(snapshotsBeforeFollowUp);
    await session.close();
  });
});
