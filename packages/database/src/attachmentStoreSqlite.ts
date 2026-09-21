import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import {
  ATTACHMENT_SCHEMA_VERSION,
  AttachmentSchema,
  type Attachment,
} from '@harness/schemas';
import {
  AttachmentStoreError,
  type AttachmentSaveInput,
  type AttachmentStore,
} from '@harness/session-core';
import type { Orm } from './client';
import { attachments, researchSessions, researchTurns } from './schema';

const SHA256_RE = /^[a-f0-9]{64}$/;

function blobPath(homeDir: string, contentHash: string): string {
  if (!SHA256_RE.test(contentHash)) {
    throw new AttachmentStoreError('ATTACHMENT_INTEGRITY_FAILURE', 'Attachment content hash is not a valid SHA-256 identity');
  }
  return join(homeDir, 'attachments', 'sha256', contentHash.slice(0, 2), contentHash);
}

function invalid(message: string, cause?: unknown): AttachmentStoreError {
  return new AttachmentStoreError('ATTACHMENT_INVALID', message, cause ? { cause } : undefined);
}

function toAttachment(row: typeof attachments.$inferSelect): Attachment {
  try {
    return AttachmentSchema.parse(row);
  } catch (error) {
    throw new AttachmentStoreError('ATTACHMENT_INTEGRITY_FAILURE', `Attachment ${row.attachmentId} metadata is invalid`, { cause: error });
  }
}

function verifyBytes(content: Uint8Array, expectedHash: string, expectedSize: number, attachmentId?: string): void {
  const actualHash = createHash('sha256').update(content).digest('hex');
  if (content.byteLength !== expectedSize || actualHash !== expectedHash) {
    throw new AttachmentStoreError(
      'ATTACHMENT_INTEGRITY_FAILURE',
      `Attachment${attachmentId ? ` ${attachmentId}` : ''} content does not match its durable metadata`,
    );
  }
}

/** SQLite metadata plus immutable content-addressed bytes under the FinHarness data root. */
export class AttachmentStoreSqlite implements AttachmentStore {
  constructor(private readonly db: Orm, private readonly homeDir: string) {}

  async save(input: AttachmentSaveInput): Promise<Attachment> {
    if (!input || typeof input !== 'object') throw invalid('Attachment save input must be an object');
    if (!input.sessionId.trim()) throw invalid('Attachment sessionId must be non-empty');
    if (!input.turnId.trim()) throw invalid('Attachment turnId must be non-empty');
    if (!input.filename.trim() || /[\\/]/.test(input.filename)) {
      throw invalid('Attachment filename must be a non-empty basename');
    }
    if (input.mediaType !== undefined && input.mediaType !== null && !input.mediaType.trim()) {
      throw invalid('Attachment mediaType must be null or non-empty');
    }
    if (!(input.content instanceof Uint8Array)) throw invalid('Attachment content must be Uint8Array');

    const session = await this.db.select({ id: researchSessions.id }).from(researchSessions)
      .where(eq(researchSessions.id, input.sessionId)).limit(1);
    if (!session[0]) throw new AttachmentStoreError('ATTACHMENT_SESSION_NOT_FOUND', `Session ${input.sessionId} not found`);
    const turn = await this.db.select({ id: researchTurns.id, sessionId: researchTurns.sessionId }).from(researchTurns)
      .where(eq(researchTurns.id, input.turnId)).limit(1);
    if (!turn[0]) throw new AttachmentStoreError('ATTACHMENT_TURN_NOT_FOUND', `Turn ${input.turnId} not found`);
    if (turn[0].sessionId !== input.sessionId) {
      throw new AttachmentStoreError('ATTACHMENT_TURN_SESSION_MISMATCH', `Turn ${input.turnId} does not belong to session ${input.sessionId}`);
    }

    const content = new Uint8Array(input.content);
    const contentHash = createHash('sha256').update(content).digest('hex');
    await this.ensureBlob(contentHash, content);
    const attachment: Attachment = {
      attachmentId: `attachment_${randomUUID()}`,
      schemaVersion: ATTACHMENT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      turnId: input.turnId,
      filename: input.filename,
      mediaType: input.mediaType ?? null,
      sizeBytes: content.byteLength,
      contentHash,
      createdAt: new Date().toISOString(),
    };
    AttachmentSchema.parse(attachment);
    try {
      await this.db.insert(attachments).values(attachment);
    } catch (error) {
      throw new AttachmentStoreError('ATTACHMENT_INVALID', `Attachment ${attachment.attachmentId} could not be persisted`, { cause: error });
    }
    return attachment;
  }

  async getById(attachmentId: string): Promise<Attachment | null> {
    const rows = await this.db.select().from(attachments).where(eq(attachments.attachmentId, attachmentId)).limit(1);
    return rows[0] ? toAttachment(rows[0]) : null;
  }

  async listBySession(sessionId: string): Promise<Attachment[]> {
    const rows = await this.db.select().from(attachments)
      .where(eq(attachments.sessionId, sessionId))
      .orderBy(asc(attachments.createdAt), asc(attachments.attachmentId));
    return rows.map(toAttachment);
  }

  async listByTurn(turnId: string): Promise<Attachment[]> {
    const rows = await this.db.select().from(attachments)
      .where(eq(attachments.turnId, turnId))
      .orderBy(asc(attachments.createdAt), asc(attachments.attachmentId));
    return rows.map(toAttachment);
  }

  async readContent(attachmentId: string): Promise<Uint8Array> {
    const attachment = await this.getById(attachmentId);
    if (!attachment) throw new AttachmentStoreError('ATTACHMENT_NOT_FOUND', `Attachment ${attachmentId} not found`);
    const path = blobPath(this.homeDir, attachment.contentHash);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AttachmentStoreError('ATTACHMENT_BLOB_MISSING', `Attachment ${attachmentId} content blob is missing`, { cause: error });
      }
      throw error;
    }
    verifyBytes(content, attachment.contentHash, attachment.sizeBytes, attachment.attachmentId);
    return new Uint8Array(content);
  }

  private async ensureBlob(contentHash: string, content: Uint8Array): Promise<void> {
    const path = blobPath(this.homeDir, contentHash);
    const directory = join(this.homeDir, 'attachments', 'sha256', contentHash.slice(0, 2));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const existing = await readFile(path);
      verifyBytes(existing, contentHash, content.byteLength);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporary = join(directory, `.${contentHash}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      try {
        await rename(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    try {
      const persisted = await readFile(path);
      verifyBytes(persisted, contentHash, content.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AttachmentStoreError('ATTACHMENT_BLOB_MISSING', 'Attachment content was not durably written', { cause: error });
      }
      throw error;
    }
  }
}
