import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import {
  attachmentToolIds,
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  createEngineCapabilityRuntime,
} from '@harness/engine';

describe('CLI attachment capability composition', () => {
  let db: FinharnessDatabase;
  let homeDir: string;
  let firstSessionId: string;
  let firstTurnId: string;
  let secondSessionId: string;
  let secondTurnId: string;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'kira-attachment-capability-'));
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

  function gatewayFor(sessionId = firstSessionId) {
    return createEngineCapabilityRuntime({
      financialData: {} as never,
      attachmentStore: db.attachments,
      documentStore: db.documents,
      sessionId,
    }).capabilityGateway;
  }

  it('lists only attachments owned by the trusted Session through command.files', async () => {
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

    await expect(gatewayFor().invoke(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentToolIds.list, {}))
      .resolves.toMatchObject({ value: [own] });
  });

  it('reads exact raw bytes through the command.doc-index grant', async () => {
    const content = new Uint8Array([0, 1, 2, 255]);
    const own = await db.attachments.save({ sessionId: firstSessionId, turnId: firstTurnId, filename: 'raw.bin', content });

    await expect(gatewayFor().invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: own.attachmentId }))
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

    await expect(gatewayFor().invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: own.attachmentId }))
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

    await expect(gatewayFor().invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: other.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(readContent).not.toHaveBeenCalled();
  });

  it('preserves missing and corrupted AttachmentStore errors through the Gateway', async () => {
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'raw.bin',
      content: new TextEncoder().encode('raw'),
    });
    const blob = join(homeDir, 'attachments', 'sha256', own.contentHash.slice(0, 2), own.contentHash);
    unlinkSync(blob);

    await expect(gatewayFor().invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: own.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_BLOB_MISSING' });

    const restored = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'restored.bin',
      content: new TextEncoder().encode('restored'),
    });
    const restoredBlob = join(homeDir, 'attachments', 'sha256', restored.contentHash.slice(0, 2), restored.contentHash);
    writeFileSync(restoredBlob, Buffer.from('corrupted'));
    await expect(gatewayFor().invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: restored.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_INTEGRITY_FAILURE' });
  });

  it('rejects caller-controlled scope and metadata fields at the tool boundary', async () => {
    const own = await db.attachments.save({
      sessionId: firstSessionId,
      turnId: firstTurnId,
      filename: 'raw.bin',
      content: new TextEncoder().encode('raw'),
    });
    const gateway = gatewayFor();

    await expect(gateway.invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, {
      attachmentId: own.attachmentId,
      sessionId: secondSessionId,
    })).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
    await expect(gateway.invoke(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentToolIds.list, { sessionId: secondSessionId }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
});
