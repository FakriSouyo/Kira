import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityGateway } from '@harness/capability';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { createHarnessSession } from '../src/repl/session';
import { loadConfig } from '../src/config';

describe('/files', () => {
  let db: FinharnessDatabase | undefined;
  let homeDir: string | undefined;
  let sourceDir: string | undefined;

  afterEach(async () => {
    db?.raw.close();
    db = undefined;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('lists current Session attachments through command.files with no Execution or model/provider work', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-command-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'finharness-files-source-'));
    const firstPath = join(sourceDir, 'alpha.txt');
    const secondPath = join(sourceDir, 'beta.csv');
    writeFileSync(firstPath, 'alpha');
    writeFileSync(secondPath, 'beta');
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: (text) => writes.push(text) },
    );
    const providerSpies = ['getCompanyReport', 'getQuarterlyFinancials', 'screen', 'getDailyTransaction', 'getForeignFlow', 'getNews', 'getFilings', 'getSentiment']
      .map(method => vi.spyOn(session.context.financialData, method as keyof typeof session.context.financialData));
    const invoke = vi.spyOn(CapabilityGateway.prototype, 'invoke');

    await session.commands.get('attach')!([firstPath], { input: `/attach "${firstPath}"` });
    await session.commands.get('attach')!([secondPath], { input: `/attach "${secondPath}"` });
    const attachments = await db.attachments.listBySession(session.conversation.id);
    expect(attachments.map(attachment => attachment.filename)).toEqual(['alpha.txt', 'beta.csv']);
    writes.length = 0;
    await session.commands.get('files')!([], { input: '/files' });

    const output = writes.join('');
    expect(output).toContain('alpha.txt');
    expect(output).toContain('beta.csv');
    for (const attachment of attachments) expect(output).toContain(attachment.attachmentId);
    expect(output.indexOf('alpha.txt')).toBeLessThan(output.indexOf('beta.csv'));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0]).toEqual({ id: 'command.files' });
    expect(invoke.mock.calls[0]?.[1]).toBe('workspace.list-attachments');
    expect(invoke.mock.calls[0]?.[2]).toEqual({});
    expect(providerSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);

    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    const filesTurn = artifacts.turns.find(turn => turn.input === '/files');
    expect(filesTurn).toMatchObject({ command: 'files', status: 'completed' });
    expect(artifacts.executions).toEqual([]);
    expect(artifacts.modelCalls).toEqual([]);
    await session.close();
  });

  it('rebinds attachment scope after openConversation so the selected Session cannot see another Session files', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-open-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'finharness-files-source-'));
    const firstPath = join(sourceDir, 'open-a.txt');
    const secondPath = join(sourceDir, 'open-b.txt');
    writeFileSync(firstPath, 'open A');
    writeFileSync(secondPath, 'open B');
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: (text) => writes.push(text) },
    );
    const firstSessionId = session.conversation.id;

    await session.commands.get('attach')!([firstPath], { input: `/attach "${firstPath}"` });
    const firstAttachment = (await db.attachments.listBySession(firstSessionId))[0];
    writes.length = 0;
    await session.commands.get('files')!([], { input: '/files' });
    expect(writes.join('')).toContain(firstAttachment.attachmentId);
    expect(writes.join('')).toContain('open-a.txt');

    const second = await db.sessions.createSession({
      sessionId: 'conversation-files-open-b',
      title: 'Session B',
      provider: 'mock',
      model: 'mock',
      reasoningMode: 'usual',
    });
    const secondTurn = await db.sessions.createTurn({ sessionId: second.id, input: '/attach [file]', command: 'attach' });
    const secondAttachment = await db.attachments.save({
      sessionId: second.id,
      turnId: secondTurn.id,
      filename: 'open-b.txt',
      content: new TextEncoder().encode('open B'),
    });

    await session.openConversation(second.id);
    writes.length = 0;
    await session.commands.get('files')!([], { input: '/files' });

    const output = writes.join('');
    expect(session.conversation.id).toBe(second.id);
    expect(output).toContain(secondAttachment.attachmentId);
    expect(output).toContain('open-b.txt');
    expect(output).not.toContain(firstAttachment.attachmentId);
    expect(output).not.toContain('open-a.txt');
    await session.close();
  });

  it('fails closed when openConversation target preparation rejects before switching the controller', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-open-failure-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'finharness-files-source-'));
    const firstPath = join(sourceDir, 'failure-a.txt');
    writeFileSync(firstPath, 'failure A');
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: (text) => writes.push(text) },
    );
    const firstSessionId = session.conversation.id;
    await session.commands.get('attach')!([firstPath], { input: `/attach "${firstPath}"` });
    const firstAttachment = (await db.attachments.listBySession(firstSessionId))[0];

    const second = await db.sessions.createSession({
      sessionId: 'conversation-files-open-failure-b',
      title: 'Session B',
      provider: 'mock',
      model: 'mock',
      reasoningMode: 'usual',
    });
    const secondTurn = await db.sessions.createTurn({ sessionId: second.id, input: '/attach [file]', command: 'attach' });
    const secondAttachment = await db.attachments.save({
      sessionId: second.id,
      turnId: secondTurn.id,
      filename: 'failure-b.txt',
      content: new TextEncoder().encode('failure B'),
    });
    await db.sessions.selectModel({
      sessionId: second.id,
      providerId: 'unavailable-provider',
      modelId: 'unavailable-model',
      source: 'user',
    });

    await expect(session.openConversation(second.id)).rejects.toMatchObject({ code: 'INVALID_PROVIDER' });
    expect(session.conversation.id).toBe(firstSessionId);
    writes.length = 0;
    await session.commands.get('files')!([], { input: '/files' });

    const output = writes.join('');
    expect(output).toContain(firstAttachment.attachmentId);
    expect(output).not.toContain(secondAttachment.attachmentId);
    expect(output).not.toContain('failure-b.txt');
    await session.close();
  });

  it('fails closed when /new target preparation rejects before switching the controller', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-new-failure-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'finharness-files-source-'));
    const firstPath = join(sourceDir, 'new-failure-a.txt');
    writeFileSync(firstPath, 'new failure A');
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: (text) => writes.push(text) },
    );
    const firstSessionId = session.conversation.id;
    await session.commands.get('attach')!([firstPath], { input: `/attach "${firstPath}"` });
    const firstAttachment = (await db.attachments.listBySession(firstSessionId))[0];
    const originalSelection = db.sessions.getCurrentModelSelection.bind(db.sessions);
    vi.spyOn(db.sessions, 'getCurrentModelSelection').mockImplementation(async (sessionId) => {
      if (sessionId !== firstSessionId) {
        return {
          sessionId,
          version: 2,
          providerId: 'unavailable-provider',
          modelId: 'unavailable-model',
          source: 'user',
          selectedAt: new Date().toISOString(),
        };
      }
      return originalSelection(sessionId);
    });

    await expect(session.commands.get('new')!([], { input: '/new' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' });
    expect(session.conversation.id).toBe(firstSessionId);
    writes.length = 0;
    await session.commands.get('files')!([], { input: '/files' });
    expect(writes.join('')).toContain(firstAttachment.attachmentId);
    await session.close();
  });

  it('rejects arguments for /files with normal structured command guidance', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-args-'));
    db = openDb({ homeDir });
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
    );

    await expect(session.commands.get('files')!(['anything'], { input: '/files anything' }))
      .rejects.toMatchObject({ code: 'INVALID_ARG', suggestion: 'Usage: /files' });
    await session.close();
  });

  it('rebinds attachment scope after /new so the new Session cannot see old files', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-rebind-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'finharness-files-source-'));
    const firstPath = join(sourceDir, 'session-a.txt');
    const secondPath = join(sourceDir, 'session-b.txt');
    writeFileSync(firstPath, 'session A');
    writeFileSync(secondPath, 'session B');
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: (text) => writes.push(text) },
    );
    const firstSessionId = session.conversation.id;

    await session.commands.get('attach')!([firstPath], { input: `/attach "${firstPath}"` });
    await session.commands.get('files')!([], { input: '/files' });
    expect(writes.join('')).toContain('session-a.txt');

    await session.commands.get('new')!([], { input: '/new' });
    const secondSessionId = session.conversation.id;
    expect(secondSessionId).not.toBe(firstSessionId);
    await session.commands.get('attach')!([secondPath], { input: `/attach "${secondPath}"` });
    writes.length = 0;
    await session.commands.get('files')!([], { input: '/files' });

    const output = writes.join('');
    expect(output).toContain('session-b.txt');
    expect(output).not.toContain('session-a.txt');
    expect(await db.attachments.listBySession(firstSessionId)).toHaveLength(1);
    expect(await db.attachments.listBySession(secondSessionId)).toHaveLength(1);
    await session.close();
  });

  it('shows a deterministic empty state for a Session without attachments', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-files-empty-'));
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: (text) => writes.push(text) },
    );

    await session.commands.get('files')!([], { input: '/files' });

    expect(writes.join('')).toContain('No attachments in the current Session.');
    await session.close();
  });
});
