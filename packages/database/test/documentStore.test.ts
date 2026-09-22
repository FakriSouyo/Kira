import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindChunkDocumentId, buildDocumentBundle, documentIdFor } from '@harness/document';
import { openDb, type FinharnessDatabase } from '@harness/database';

describe('DocumentStoreSqlite', () => {
  let db: FinharnessDatabase;
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-document-store-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function lifecycle(sessionId: string, turnId: string) {
    const session = await db.sessions.createSession({
      sessionId,
      title: 'Document test',
      provider: 'mock',
      model: 'mock',
      reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId, turnId, input: '/doc-index attachment', command: 'doc-index' });
    const attachmentContent = new TextEncoder().encode('Revenue grew.\n\nDebt remains high.');
    const attachment = await db.attachments.save({
      sessionId,
      turnId,
      filename: `${sessionId}.txt`,
      content: attachmentContent,
    });
    return { session, turn, attachment, attachmentContent };
  }

  it('persists ordered chunks, survives restart, and exposes only the owning Session', async () => {
    const first = await lifecycle('document-session-a', 'document-turn-a');
    const second = await lifecycle('document-session-b', 'document-turn-b');
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id, createdAt: '2026-09-22T00:00:01.000Z' });
    const saved = await db.documents.save(bundle);

    expect(saved).toEqual(bundle);
    expect(await db.documents.getByAttachment({ attachmentId: first.attachment.attachmentId, extractorId: bundle.document.extractorId, extractorVersion: bundle.document.extractorVersion })).toEqual(bundle);
    expect(await db.documents.listBySession(first.session.id)).toEqual([bundle]);
    expect(await db.documents.listBySession(second.session.id)).toEqual([]);
    expect(db.raw.prepare('SELECT name FROM _migrations WHERE name = ?').get('./0016_documents.sql')).toEqual({ name: './0016_documents.sql' });

    db.raw.close();
    db = openDb({ homeDir });
    expect(await db.documents.getById(bundle.document.documentId)).toEqual(bundle);
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('is idempotent for the immutable source and rejects conflicting writes', async () => {
    const first = await lifecycle('document-session-idempotent', 'document-turn-idempotent');
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id, createdAt: '2026-09-22T00:00:01.000Z' });
    await expect(db.documents.save(bundle)).resolves.toEqual(bundle);
    await expect(db.documents.save(bundle)).resolves.toEqual(bundle);

    const conflict = {
      ...bundle,
      document: { ...bundle.document, textHash: createHash('sha256').update('different').digest('hex') },
    };
    await expect(db.documents.save(conflict)).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 1 });
  });

  it('stores separate versions for the same Attachment and resolves each by explicit extractor identity', async () => {
    const first = await lifecycle('document-session-versioned', 'document-turn-versioned');
    const versionOne = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id });
    const extractorVersion = 'pipeline-v2';
    const documentId = documentIdFor({ attachmentId: versionOne.document.attachmentId, sourceContentHash: versionOne.document.sourceContentHash, extractorId: versionOne.document.extractorId, extractorVersion });
    const versionTwo = {
      document: { ...versionOne.document, documentId, extractorVersion },
      chunks: bindChunkDocumentId(versionOne.chunks, documentId),
    };
    await expect(db.documents.save(versionOne)).resolves.toEqual(versionOne);
    await expect(db.documents.save(versionOne)).resolves.toEqual(versionOne);
    await expect(db.documents.save(versionTwo)).resolves.toEqual(versionTwo);
    await expect(db.documents.getByAttachment({ attachmentId: first.attachment.attachmentId, extractorId: versionOne.document.extractorId, extractorVersion: versionOne.document.extractorVersion })).resolves.toEqual(versionOne);
    await expect(db.documents.getByAttachment({ attachmentId: first.attachment.attachmentId, extractorId: versionTwo.document.extractorId, extractorVersion })).resolves.toEqual(versionTwo);
    expect((await db.documents.listBySession(first.session.id)).map(bundle => bundle.document.documentId)).toEqual([versionOne.document.documentId, versionTwo.document.documentId].sort());
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 2 });
  });

  it.each([
    ['wrong chunk text', 'UPDATE document_chunks SET text = ? WHERE chunk_id = ?', 'tampered'],
    ['wrong chunk contentHash', 'UPDATE document_chunks SET content_hash = ? WHERE chunk_id = ?', '0'.repeat(64)],
    ['wrong chunk ID', 'UPDATE document_chunks SET chunk_id = ? WHERE chunk_id = ?', 'chunk_tampered'],
    ['wrong ordinal', 'UPDATE document_chunks SET ordinal = ? WHERE chunk_id = ?', 9],
    ['wrong document identity field', 'UPDATE documents SET extractor_version = ? WHERE document_id = ?', 'tampered'],
    ['wrong declared chunk count', 'UPDATE documents SET chunk_count = ? WHERE document_id = ?', 9],
  ])('rejects a persisted %s on all read paths', async (_name, sql, replacement) => {
    const first = await lifecycle(`document-session-corrupt-${_name.replaceAll(' ', '-')}`, `document-turn-corrupt-${_name.replaceAll(' ', '-')}`);
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id });
    await db.documents.save(bundle);
    const target = sql.includes('UPDATE documents ') ? bundle.document.documentId : bundle.chunks[0]!.chunkId;
    db.raw.prepare(sql).run(replacement, target);
    await expect(db.documents.getById(bundle.document.documentId)).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
    const extractorVersion = sql.includes('SET extractor_version') ? 'tampered' : bundle.document.extractorVersion;
    await expect(db.documents.getByAttachment({ attachmentId: first.attachment.attachmentId, extractorId: bundle.document.extractorId, extractorVersion })).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
    await expect(db.documents.listBySession(first.session.id)).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
  });

  it('rejects persisted Session and indexing Turn ownership drift', async () => {
    const first = await lifecycle('document-session-drift-a', 'document-turn-drift-a');
    const second = await lifecycle('document-session-drift-b', 'document-turn-drift-b');
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id });
    await db.documents.save(bundle);
    db.raw.prepare('UPDATE documents SET session_id = ? WHERE document_id = ?').run(second.session.id, bundle.document.documentId);
    await expect(db.documents.getById(bundle.document.documentId)).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
    db.raw.prepare('UPDATE documents SET session_id = ?, created_by_turn_id = ? WHERE document_id = ?').run(first.session.id, second.turn.id, bundle.document.documentId);
    await expect(db.documents.getById(bundle.document.documentId)).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
  });

  it('cascades derived Documents and chunks when their Attachment is deleted', async () => {
    const first = await lifecycle('document-session-attachment-delete', 'document-turn-attachment-delete');
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id });
    await db.documents.save(bundle);
    db.raw.prepare('DELETE FROM attachments WHERE attachment_id = ?').run(first.attachment.attachmentId);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM document_chunks').get()).toEqual({ count: 0 });
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('cascades derived Documents and chunks when their Session and Turn are deleted', async () => {
    const first = await lifecycle('document-session-session-delete', 'document-turn-session-delete');
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id });
    await db.documents.save(bundle);
    db.raw.prepare('DELETE FROM research_sessions WHERE id = ?').run(first.session.id);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({ count: 0 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM document_chunks').get()).toEqual({ count: 0 });
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('rejects source, Turn, and chunk ownership mismatches before persistence', async () => {
    const first = await lifecycle('document-session-owner-a', 'document-turn-owner-a');
    const second = await lifecycle('document-session-owner-b', 'document-turn-owner-b');
    const bundle = await buildDocumentBundle({ attachment: first.attachment, content: first.attachmentContent, createdByTurnId: first.turn.id });

    await expect(db.documents.save({
      ...bundle,
      document: { ...bundle.document, sessionId: second.session.id },
    })).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
    await expect(db.documents.save({
      ...bundle,
      document: { ...bundle.document, createdByTurnId: second.turn.id },
    })).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
    await expect(db.documents.save({
      ...bundle,
      chunks: [{ ...bundle.chunks[0]!, ordinal: 1 }],
    })).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
  });
});
