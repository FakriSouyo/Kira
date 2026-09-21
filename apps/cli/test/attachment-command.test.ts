import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { CapabilityGateway } from '@harness/capability';
import { createHarnessSession } from '../src/repl/session';
import { loadConfig } from '../src/config';

describe('/attach', () => {
  let db: FinharnessDatabase | undefined;
  let homeDir: string | undefined;
  const sourceDirs: string[] = [];

  afterEach(async () => {
    db?.raw.close();
    db = undefined;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    homeDir = undefined;
    for (const dir of sourceDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('imports one quoted path into a Turn without an Execution, model call, provider call, or capability call', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-attach-cli-'));
    const sourceDir = mkdtempSync(join(tmpdir(), 'finharness-attach-source-'));
    sourceDirs.push(sourceDir);
    const nested = join(sourceDir, 'path with spaces');
    mkdirSync(nested);
    const sourcePath = join(nested, 'report.pdf');
    const original = Buffer.from([0, 1, 2, 255, 10]);
    writeFileSync(sourcePath, original);
    db = openDb({ homeDir });
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => {} });
    const providerMethods = ['getCompanyReport', 'getQuarterlyFinancials', 'screen', 'getDailyTransaction', 'getForeignFlow', 'getNews', 'getFilings', 'getSentiment'] as const;
    const providerSpies = providerMethods.map(method => vi.spyOn(session.context.financialData, method));
    const capabilityInvoke = vi.spyOn(CapabilityGateway.prototype, 'invoke');

    await session.commands.get('attach')!([sourcePath], { input: `/attach "${sourcePath}"` });
    const sessionId = session.conversation.id;
    const attachments = await db.attachments.listBySession(sessionId);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ sessionId, filename: 'report.pdf', sizeBytes: original.length, mediaType: null });
    const attached = attachments[0]!;

    rmSync(sourcePath);
    expect(await db.attachments.readContent(attached.attachmentId)).toEqual(new Uint8Array(original));
    const artifacts = await db.sessions.getSessionArtifacts(sessionId);
    const turn = artifacts.turns.find(candidate => candidate.id === attached.turnId)!;
    expect(turn).toMatchObject({ command: 'attach', input: '/attach [file]', status: 'completed' });
    expect(artifacts.executions).toEqual([]);
    expect(artifacts.modelCalls).toEqual([]);
    expect(db.journal.read(sessionId).some(entry => JSON.stringify(entry.payload).includes(sourcePath))).toBe(false);
    expect(providerSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(capabilityInvoke).not.toHaveBeenCalled();
    await session.close();
  });

  it('rejects missing and multiple paths before saving an attachment', async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-attach-args-'));
    db = openDb({ homeDir });
    const session = await createHarnessSession(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }), { write: () => {} });

    await expect(session.commands.get('attach')!([], { input: '/attach' })).rejects.toMatchObject({ code: 'MISSING_ARG' });
    await expect(session.commands.get('attach')!(['one', 'two'], { input: '/attach one two' })).rejects.toMatchObject({ code: 'INVALID_ARG' });
    const directory = join(homeDir, 'not-a-file');
    mkdirSync(directory);
    await expect(session.commands.get('attach')!([directory], { input: `/attach "${directory}"` })).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FILE' });
    expect(await db.attachments.listBySession(session.conversation.id)).toEqual([]);
    await session.close();
  });
});
