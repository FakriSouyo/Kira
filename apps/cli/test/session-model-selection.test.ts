import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';
import { ConversationController } from '../src/ui/conversationController';

let db: FinharnessDatabase;
let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'finharness-cli-selection-'));
  writeFileSync(join(homeDir, 'config.json'), JSON.stringify({
    llm: { agent: { provider: 'openai', model: 'configured-model' }, router: { provider: 'openai', model: 'router-model' } },
  }));
  db = openDb({ homeDir });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (db.raw.open) db.raw.close();
  rmSync(homeDir, { recursive: true, force: true });
});

describe('session-local model selection', () => {
  it('persists selection without modifying global config.json', async () => {
    const before = readFileSync(join(homeDir, 'config.json'), 'utf8');
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));

    await session.setModel('session-only-model');

    expect(readFileSync(join(homeDir, 'config.json'), 'utf8')).toBe(before);
    expect(await db.sessions.getCurrentModelSelection(session.conversation.id)).toMatchObject({
      providerId: 'openai', modelId: 'session-only-model', source: 'user', version: 2,
    });
    await session.close();
  });

  it('seeds /new from the global default instead of the previous Session selection', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));
    const firstSessionId = session.conversation.id;
    await session.setModel('session-only-model');
    const getSessionArtifacts = vi.spyOn(db.sessions, 'getSessionArtifacts');

    await session.commands.get('new')!([], { input: '/new' });

    expect(session.conversation.id).not.toBe(firstSessionId);
    expect(getSessionArtifacts.mock.calls.filter(([sessionId]) => sessionId === firstSessionId)).toHaveLength(0);
    expect(await db.sessions.getCurrentModelSelection(firstSessionId)).toMatchObject({ version: 2, modelId: 'session-only-model', source: 'user' });
    expect(await db.sessions.getCurrentModelSelection(session.conversation.id)).toMatchObject({ version: 1, providerId: 'openai', modelId: 'configured-model', source: 'initial' });
    const oldArtifacts = await db.sessions.getSessionArtifacts(firstSessionId);
    expect(oldArtifacts.turns).toHaveLength(1);
    expect(oldArtifacts.turns[0]).toMatchObject({ command: 'new', status: 'completed' });
    expect(oldArtifacts.executions).toEqual([]);
    expect(await db.workingContext.current(firstSessionId)).toBeNull();
    expect(await db.workingContext.current(session.conversation.id)).toBeNull();
    expect(db.journal.read(session.conversation.id)?.filter(entry => entry.payload.type === 'session.context.updated')).toEqual([]);
    await session.close();
  });

  it('uses live failure policy when host Turn-start projection fails before /new settlement', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));
    const sessionId = session.conversation.id;
    const error = new Error('Turn-start projection failed');
    const beginTurn = ConversationController.prototype.beginTurn;
    vi.spyOn(ConversationController.prototype, 'beginTurn').mockImplementation(function (this: ConversationController, turnId) {
      beginTurn.call(this, turnId);
      throw error;
    });
    const settleTurn = vi.spyOn(db.sessions, 'settleTurn');

    await expect(session.commands.get('new')!([], { input: '/new' })).rejects.toBe(error);

    expect(session.conversation.id).toBe(sessionId);
    expect(settleTurn).toHaveBeenCalledTimes(1);
    expect(settleTurn).toHaveBeenCalledWith(expect.any(String), 'failed');
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    expect(artifacts.turns).toHaveLength(1);
    expect(artifacts.turns[0]).toMatchObject({ command: 'new', status: 'failed' });
    expect(artifacts.executions).toEqual([]);
    await session.close();
  });

  it('does not re-settle the completed /new Turn when new Session creation fails', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));
    const sessionId = session.conversation.id;
    const error = new Error('Session creation failed');
    vi.spyOn(db.sessions, 'createSession').mockRejectedValueOnce(error);
    const settleTurn = vi.spyOn(db.sessions, 'settleTurn');

    await expect(session.commands.get('new')!([], { input: '/new' })).rejects.toBe(error);

    expect(session.conversation.id).toBe(sessionId);
    expect(settleTurn).toHaveBeenCalledTimes(1);
    expect(settleTurn).toHaveBeenCalledWith(expect.any(String), 'completed');
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    expect(artifacts.turns).toHaveLength(1);
    expect(artifacts.turns[0]).toMatchObject({ command: 'new', status: 'completed' });
    expect(artifacts.executions).toEqual([]);
    await session.close();
  });

  it('does not re-settle the canonical Turn when host settlement projection fails after completion', async () => {
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));
    const sessionId = session.conversation.id;
    const error = new Error('Turn settlement projection failed');
    const settleProjection = ConversationController.prototype.settleTurn;
    vi.spyOn(ConversationController.prototype, 'settleTurn').mockImplementation(function (this: ConversationController, turnId, state) {
      settleProjection.call(this, turnId, state);
      throw error;
    });
    const settleTurn = vi.spyOn(db.sessions, 'settleTurn');

    await expect(session.commands.get('new')!([], { input: '/new' })).rejects.toBe(error);

    expect(session.conversation.id).toBe(sessionId);
    expect(settleTurn).toHaveBeenCalledTimes(1);
    expect(settleTurn).toHaveBeenCalledWith(expect.any(String), 'completed');
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    expect(artifacts.turns).toHaveLength(1);
    expect(artifacts.turns[0]).toMatchObject({ command: 'new', status: 'completed' });
    await session.close();
  });
});
