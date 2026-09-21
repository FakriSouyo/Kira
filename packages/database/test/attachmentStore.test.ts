import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

describe('AttachmentStoreSqlite', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-attachment-store-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function lifecycle(sessionId = 'session_attachment', turnId = 'turn_attachment') {
    const session = await db.sessions.createSession({
      sessionId,
      title: 'Attachment test',
      provider: 'openai',
      model: 'mock',
      reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      sessionId: session.id,
      turnId,
      input: '/attach [file]',
      command: 'attach',
    });
    return { session, turn };
  }

  it('saves exact bytes and preserves metadata and content after database restart', async () => {
    const { session, turn } = await lifecycle();
    const content = new Uint8Array([0, 1, 2, 255]);
    const saved = await db.attachments.save({
      sessionId: session.id,
      turnId: turn.id,
      filename: 'report.pdf',
      content,
    });

    expect(saved).toMatchObject({
      sessionId: session.id,
      turnId: turn.id,
      filename: 'report.pdf',
      mediaType: null,
      sizeBytes: 4,
      contentHash: createHash('sha256').update(content).digest('hex'),
    });
    expect(await db.attachments.readContent(saved.attachmentId)).toEqual(content);

    db.raw.close();
    db = openDb({ homeDir });
    expect(await db.attachments.getById(saved.attachmentId)).toEqual(saved);
    expect(await db.attachments.readContent(saved.attachmentId)).toEqual(content);
  });

  it('creates distinct attachment identities while deduplicating the immutable blob', async () => {
    const { session, turn } = await lifecycle();
    const first = await db.attachments.save({ sessionId: session.id, turnId: turn.id, filename: 'one.txt', content: new TextEncoder().encode('same bytes') });
    const second = await db.attachments.save({ sessionId: session.id, turnId: turn.id, filename: 'two.txt', content: new TextEncoder().encode('same bytes') });

    expect(second.attachmentId).not.toBe(first.attachmentId);
    expect(second.contentHash).toBe(first.contentHash);
    expect(await db.attachments.readContent(first.attachmentId)).toEqual(await db.attachments.readContent(second.attachmentId));
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 2 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM attachments WHERE content_hash = ?').get(first.contentHash)).toEqual({ count: 2 });
  });

  it('validates session and Turn ownership before persisting metadata', async () => {
    const first = await lifecycle('session_first', 'turn_first');
    const second = await lifecycle('session_second', 'turn_second');
    const content = new TextEncoder().encode('owned');

    await expect(db.attachments.save({ sessionId: 'missing', turnId: first.turn.id, filename: 'x.txt', content }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_SESSION_NOT_FOUND' });
    await expect(db.attachments.save({ sessionId: first.session.id, turnId: 'missing', filename: 'x.txt', content }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TURN_NOT_FOUND' });
    await expect(db.attachments.save({ sessionId: first.session.id, turnId: second.turn.id, filename: 'x.txt', content }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_TURN_SESSION_MISMATCH' });
  });

  it('lists attachments by session and Turn in deterministic order', async () => {
    const first = await lifecycle('session_list', 'turn_first');
    const secondTurn = await db.sessions.createTurn({ sessionId: first.session.id, turnId: 'turn_second', input: '/attach [file]', command: 'attach' });
    const one = await db.attachments.save({ sessionId: first.session.id, turnId: first.turn.id, filename: 'one.txt', content: new TextEncoder().encode('one') });
    const two = await db.attachments.save({ sessionId: first.session.id, turnId: secondTurn.id, filename: 'two.txt', content: new TextEncoder().encode('two') });

    expect(await db.attachments.listBySession(first.session.id)).toEqual([one, two]);
    expect(await db.attachments.listByTurn(first.turn.id)).toEqual([one]);
    expect(await db.attachments.listByTurn(secondTurn.id)).toEqual([two]);
  });

  it('fails closed when the content blob is missing or corrupted', async () => {
    const { session, turn } = await lifecycle();
    const content = new TextEncoder().encode('integrity');
    const saved = await db.attachments.save({ sessionId: session.id, turnId: turn.id, filename: 'integrity.txt', content });
    const blob = join(homeDir, 'attachments', 'sha256', saved.contentHash.slice(0, 2), saved.contentHash);

    unlinkSync(blob);
    await expect(db.attachments.readContent(saved.attachmentId)).rejects.toMatchObject({ code: 'ATTACHMENT_BLOB_MISSING' });

    const restored = await db.attachments.save({ sessionId: session.id, turnId: turn.id, filename: 'integrity-again.txt', content });
    const restoredBlob = join(homeDir, 'attachments', 'sha256', restored.contentHash.slice(0, 2), restored.contentHash);
    expect(existsSync(restoredBlob)).toBe(true);
    writeFileSync(restoredBlob, Buffer.from('corrupted'));
    await expect(db.attachments.readContent(restored.attachmentId)).rejects.toMatchObject({ code: 'ATTACHMENT_INTEGRITY_FAILURE' });
  });

  it('rejects non-filename metadata so source paths cannot become durable locators', async () => {
    const { session, turn } = await lifecycle();
    await expect(db.attachments.save({ sessionId: session.id, turnId: turn.id, filename: '../report.pdf', content: new Uint8Array([1]) }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' });
  });
});
