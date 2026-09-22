import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { ToolRuntime } from '@harness/tool-runtime';
import { createAttachmentTools, attachmentToolIds } from '../src/tools/attachmentTools';
import {
  ATTACHMENT_CAPABILITY_INTEGRATION_ID,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  createAttachmentCapabilityRegistrations,
} from '../src/tools/attachmentCapabilities';
import {
  createApplicationCapabilityGateway,
  createApplicationCapabilityRegistrations,
} from '../src/tools/applicationCapabilities';
import { createFinancialTools } from '../src/tools/financialTools';
import { JUDGE_CAPABILITY_PRINCIPALS, SCREEN_CAPABILITY_PRINCIPAL } from '../src/tools/financialCapabilities';
import type { FinancialDataProvider } from '@harness/financial-data';

describe('session-scoped attachment capabilities', () => {
  let db: FinharnessDatabase;
  let homeDir: string;
  let firstSessionId: string;
  let firstTurnId: string;
  let secondSessionId: string;
  let secondTurnId: string;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-attachment-capability-'));
    db = openDb({ homeDir });
    const first = await db.sessions.createSession({
      sessionId: 'attachment-capability-first',
      title: 'First',
      provider: 'mock',
      model: 'mock',
      reasoningMode: 'usual',
    });
    const second = await db.sessions.createSession({
      sessionId: 'attachment-capability-second',
      title: 'Second',
      provider: 'mock',
      model: 'mock',
      reasoningMode: 'usual',
    });
    firstSessionId = first.id;
    secondSessionId = second.id;
    firstTurnId = (await db.sessions.createTurn({ sessionId: first.id, input: '/attach [file]', command: 'attach' })).id;
    secondTurnId = (await db.sessions.createTurn({ sessionId: second.id, input: '/attach [file]', command: 'attach' })).id;
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  function toolsFor(sessionId = firstSessionId) {
    return createAttachmentTools({ attachmentStore: db.attachments, sessionId });
  }

  it('lists only attachments owned by the trusted Session', async () => {
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'own.txt',
      content: new TextEncoder().encode('own'),
    });
    await db.attachments.save({
      sessionId: secondSessionId,
      turnId: secondTurnId,
      filename: 'other.txt',
      content: new TextEncoder().encode('other'),
    });

    const result = await new ToolRuntime().invoke(toolsFor().list, {});

    expect(result.value).toEqual([own]);
  });

  it('describes an attachment from the trusted Session', async () => {
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'own.txt',
      content: new TextEncoder().encode('own'),
    });

    await expect(new ToolRuntime().invoke(toolsFor().describe, { attachmentId: own.attachmentId }))
      .resolves.toMatchObject({ value: own });
  });

  it('uses the same not-found boundary for unknown and cross-Session descriptions', async () => {
    const other = await db.attachments.save({
      sessionId: secondSessionId,
      turnId: secondTurnId,
      filename: 'other.txt',
      content: new TextEncoder().encode('other'),
    });
    const runtime = new ToolRuntime();

    const unknown = await runtime.invoke(toolsFor().describe, { attachmentId: 'attachment_unknown' }).catch(error => error);
    const crossSession = await runtime.invoke(toolsFor().describe, { attachmentId: other.attachmentId }).catch(error => error);

    expect(unknown).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(crossSession).toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(crossSession.message).toContain('not found');
    expect(crossSession.message).not.toMatch(/another Session|belongs to/i);
  });

  it('reads exact raw bytes for an owned attachment', async () => {
    const content = new Uint8Array([0, 1, 2, 255]);
    const own = await db.attachments.save({ sessionId: firstSessionId, turnId: firstTurnId, filename: 'raw.bin', content });

    await expect(new ToolRuntime().invoke(toolsFor().read, { attachmentId: own.attachmentId }))
      .resolves.toMatchObject({ value: { attachment: own, content } });
  });

  it('reads durable bytes after the original host source file is removed', async () => {
    const sourcePath = join(homeDir, 'selected-source.bin');
    const original = Buffer.from([0, 9, 255]);
    writeFileSync(sourcePath, original);
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'selected-source.bin',
      content: new Uint8Array(readFileSync(sourcePath)),
    });
    rmSync(sourcePath);

    await expect(new ToolRuntime().invoke(toolsFor().read, { attachmentId: own.attachmentId }))
      .resolves.toMatchObject({ value: { attachment: own, content: new Uint8Array(original) } });
  });

  it('rejects cross-Session reads before the store can expose bytes', async () => {
    const other = await db.attachments.save({
      sessionId: secondSessionId,
      turnId: secondTurnId,
      filename: 'other.txt',
      content: new TextEncoder().encode('other'),
    });
    const readContent = vi.spyOn(db.attachments, 'readContent');

    await expect(new ToolRuntime().invoke(toolsFor().read, { attachmentId: other.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(readContent).not.toHaveBeenCalled();
  });

  it('preserves missing and corrupted AttachmentStore errors through the tool runtime', async () => {
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'raw.bin',
      content: new TextEncoder().encode('raw'),
    });
    const blob = join(homeDir, 'attachments', 'sha256', own.contentHash.slice(0, 2), own.contentHash);
    unlinkSync(blob);

    await expect(new ToolRuntime().invoke(toolsFor().read, { attachmentId: own.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_BLOB_MISSING' });

    const restored = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'restored.bin',
      content: new TextEncoder().encode('restored'),
    });
    const restoredBlob = join(homeDir, 'attachments', 'sha256', restored.contentHash.slice(0, 2), restored.contentHash);
    writeFileSync(restoredBlob, Buffer.from('corrupted'));
    await expect(new ToolRuntime().invoke(toolsFor().read, { attachmentId: restored.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_INTEGRITY_FAILURE' });
  });

  it('rejects caller-controlled scope, path, and contentHash fields', async () => {
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'raw.bin',
      content: new TextEncoder().encode('raw'),
    });
    const runtime = new ToolRuntime();

    await expect(runtime.invoke(toolsFor().describe, { attachmentId: own.attachmentId, sessionId: secondSessionId }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(runtime.invoke(toolsFor().describe, { attachmentId: own.attachmentId, path: 'raw.bin' }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(runtime.invoke(toolsFor().describe, { attachmentId: own.attachmentId, contentHash: own.contentHash }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(runtime.invoke(toolsFor().list, { sessionId: secondSessionId }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
});

describe('application attachment capability composition', () => {
  const provider = {} as FinancialDataProvider;

  it('registers attachment tools with data-only descriptors', () => {
    const tools = createAttachmentTools({
      attachmentStore: {} as never,
      sessionId: 'trusted-session',
    });
    const registrations = createAttachmentCapabilityRegistrations(tools);

    expect(registrations.map(({ descriptor }) => descriptor.id)).toEqual([
      attachmentToolIds.list,
      attachmentToolIds.describe,
      attachmentToolIds.read,
    ]);
    expect(registrations.every(({ descriptor }) => descriptor.integrationId === ATTACHMENT_CAPABILITY_INTEGRATION_ID)).toBe(true);
    for (const { descriptor } of registrations) {
      expect(Object.keys(descriptor).sort()).toEqual(['description', 'displayName', 'id', 'integrationId', 'kind']);
      expect(descriptor).not.toHaveProperty('sessionId');
      expect(descriptor).not.toHaveProperty('attachmentId');
      expect(descriptor).not.toHaveProperty('tool');
    }
  });

  it('combines financial and attachment registrations while granting command.files only list', async () => {
    const attachments = createAttachmentTools({ attachmentStore: {} as never, sessionId: 'trusted-session' });
    const financialTools = createFinancialTools(provider);
    const registrations = createApplicationCapabilityRegistrations({ financialTools, attachmentTools: attachments });
    const gateway = createApplicationCapabilityGateway({
      financialTools,
      attachmentTools: attachments,
      toolRuntime: new ToolRuntime(),
    });

    expect(registrations.map(({ descriptor }) => descriptor.id)).toEqual([
      'financial.company-report',
      'financial.quarterly-financials',
      'financial.screen',
      'financial.daily-transaction',
      'financial.foreign-flow',
      'financial.news',
      'financial.filings',
      'financial.sentiment',
      attachmentToolIds.list,
      attachmentToolIds.describe,
      attachmentToolIds.read,
    ]);
    expect(gateway.list(COMMAND_FILES_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([attachmentToolIds.list]);
    expect(() => gateway.describe(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentToolIds.describe))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => gateway.describe(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentToolIds.read))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => gateway.describe(COMMAND_FILES_CAPABILITY_PRINCIPAL, 'financial.screen'))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));

    const protectedAttachmentIds = Object.values(attachmentToolIds);
    const deniedPrincipals = [
      SCREEN_CAPABILITY_PRINCIPAL,
      ...Object.values(JUDGE_CAPABILITY_PRINCIPALS),
    ];
    for (const principal of deniedPrincipals) {
      for (const capabilityId of protectedAttachmentIds) {
        await expect(gateway.invoke(principal, capabilityId, {}))
          .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
      }
    }
  });
});
