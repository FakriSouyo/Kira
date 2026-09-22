import { and, asc, eq } from 'drizzle-orm';
import {
  DocumentChunkSchema,
  DocumentSchema,
  type Document,
  type DocumentChunk,
} from '@harness/schemas';
import {
  DocumentError,
  chunkIdFor,
  documentIdFor,
  sha256Hex,
  type DocumentBundle,
  type DocumentStore,
} from '@harness/document';
import { canonicalJson } from '@harness/shared';
import type { Orm } from './client';
import { attachments, documentChunks, documents, researchTurns } from './schema';

type DocumentRow = typeof documents.$inferSelect;
type DocumentChunkRow = typeof documentChunks.$inferSelect;

function toDocument(row: DocumentRow): Document {
  return DocumentSchema.parse({
    documentId: row.documentId,
    schemaVersion: row.schemaVersion,
    sessionId: row.sessionId,
    attachmentId: row.attachmentId,
    sourceContentHash: row.sourceContentHash,
    filename: row.filename,
    detectedMediaType: row.detectedMediaType,
    extractorId: row.extractorId,
    extractorVersion: row.extractorVersion,
    textHash: row.textHash,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    createdByTurnId: row.createdByTurnId,
    createdAt: row.createdAt,
  });
}

function toChunk(row: DocumentChunkRow): DocumentChunk {
  return DocumentChunkSchema.parse({
    chunkId: row.chunkId,
    schemaVersion: row.schemaVersion,
    documentId: row.documentId,
    ordinal: row.ordinal,
    text: row.text,
    contentHash: row.contentHash,
    pageStart: row.pageStart,
    pageEnd: row.pageEnd,
    lineStart: row.lineStart,
    lineEnd: row.lineEnd,
    section: row.section,
  });
}

function integrity(message: string): DocumentError {
  return new DocumentError('DOCUMENT_INTEGRITY_FAILURE', message);
}

function validateBundle(bundle: DocumentBundle): DocumentBundle {
  const document = DocumentSchema.parse(bundle.document);
  const chunks = bundle.chunks.map(chunk => DocumentChunkSchema.parse(chunk));
  if (document.chunkCount !== chunks.length) throw integrity(`Document ${document.documentId} chunk count does not match`);
  chunks.forEach((chunk, ordinal) => {
    if (chunk.documentId !== document.documentId || chunk.ordinal !== ordinal) {
      throw integrity(`Document ${document.documentId} chunk ordering or ownership is invalid`);
    }
    if (sha256Hex(chunk.text) !== chunk.contentHash) {
      throw integrity(`Document ${document.documentId} chunk ${chunk.chunkId} hash does not match its text`);
    }
    if (chunkIdFor(document.documentId, ordinal, chunk.contentHash) !== chunk.chunkId) {
      throw integrity(`Document ${document.documentId} chunk ${chunk.chunkId} identity does not match`);
    }
  });
  const expectedId = documentIdFor({
    attachmentId: document.attachmentId,
    sourceContentHash: document.sourceContentHash,
    extractorId: document.extractorId,
    extractorVersion: document.extractorVersion,
  });
  if (expectedId !== document.documentId) throw integrity(`Document ${document.documentId} identity does not match its immutable source fields`);
  return { document, chunks };
}

function comparable(bundle: DocumentBundle): string {
  return canonicalJson({
    document: {
      ...bundle.document,
      createdByTurnId: undefined,
      createdAt: undefined,
    },
    chunks: bundle.chunks,
  });
}

export class DocumentStoreSqlite implements DocumentStore {
  constructor(private readonly db: Orm) {}

  async save(input: DocumentBundle): Promise<DocumentBundle> {
    const bundle = validateBundle(input);
    return this.db.transaction((tx) => {
      const attachment = tx.select().from(attachments).where(eq(attachments.attachmentId, bundle.document.attachmentId)).limit(1).get();
      if (!attachment) throw new DocumentError('DOCUMENT_NOT_FOUND', `Attachment ${bundle.document.attachmentId} was not found`);
      if (attachment.sessionId !== bundle.document.sessionId
        || attachment.contentHash !== bundle.document.sourceContentHash
        || attachment.filename !== bundle.document.filename) {
        throw integrity(`Document ${bundle.document.documentId} source attachment does not match`);
      }
      const turn = tx.select().from(researchTurns).where(eq(researchTurns.id, bundle.document.createdByTurnId)).limit(1).get();
      if (!turn) throw integrity(`Document ${bundle.document.documentId} indexing Turn was not found`);
      if (turn.sessionId !== bundle.document.sessionId) throw integrity(`Document ${bundle.document.documentId} indexing Turn belongs to another Session`);

      const existingById = tx.select().from(documents).where(eq(documents.documentId, bundle.document.documentId)).limit(1).get();
      const existingBySource = tx.select().from(documents).where(and(
        eq(documents.attachmentId, bundle.document.attachmentId),
        eq(documents.extractorId, bundle.document.extractorId),
        eq(documents.extractorVersion, bundle.document.extractorVersion),
      )).limit(1).get();
      if (existingBySource && existingBySource.documentId !== bundle.document.documentId) {
        throw integrity(`Attachment ${bundle.document.attachmentId} already has a conflicting Document for this extractor version`);
      }
      if (existingById || existingBySource) {
        const existingDocument = (existingById ?? existingBySource)!;
        const existingChunks = tx.select().from(documentChunks)
          .where(eq(documentChunks.documentId, existingDocument.documentId))
          .orderBy(asc(documentChunks.ordinal)).all();
        const existingBundle: DocumentBundle = {
          document: toDocument(existingDocument as DocumentRow),
          chunks: existingChunks.map(row => toChunk(row as DocumentChunkRow)),
        };
        if (comparable(validateBundle(existingBundle)) !== comparable(bundle)) {
          throw integrity(`Document ${bundle.document.documentId} immutable write conflict`);
        }
        return existingBundle;
      }

      tx.insert(documents).values({
        documentId: bundle.document.documentId,
        schemaVersion: bundle.document.schemaVersion,
        sessionId: bundle.document.sessionId,
        attachmentId: bundle.document.attachmentId,
        sourceContentHash: bundle.document.sourceContentHash,
        filename: bundle.document.filename,
        detectedMediaType: bundle.document.detectedMediaType,
        extractorId: bundle.document.extractorId,
        extractorVersion: bundle.document.extractorVersion,
        textHash: bundle.document.textHash,
        pageCount: bundle.document.pageCount,
        chunkCount: bundle.document.chunkCount,
        createdByTurnId: bundle.document.createdByTurnId,
        createdAt: bundle.document.createdAt,
      }).run();
      for (const chunk of bundle.chunks) {
        tx.insert(documentChunks).values({
          chunkId: chunk.chunkId,
          schemaVersion: chunk.schemaVersion,
          documentId: chunk.documentId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          contentHash: chunk.contentHash,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          section: chunk.section,
        }).run();
      }
      return bundle;
    });
  }

  async getById(documentId: string): Promise<DocumentBundle | null> {
    const row = this.db.select().from(documents).where(eq(documents.documentId, documentId)).limit(1).get();
    return row ? this.readBundle(row as DocumentRow) : null;
  }

  async getByAttachment(source: { attachmentId: string; extractorId: string; extractorVersion: string }): Promise<DocumentBundle | null> {
    const row = this.db.select().from(documents).where(and(
      eq(documents.attachmentId, source.attachmentId),
      eq(documents.extractorId, source.extractorId),
      eq(documents.extractorVersion, source.extractorVersion),
    )).limit(1).get();
    return row ? this.readBundle(row as DocumentRow) : null;
  }

  async listBySession(sessionId: string): Promise<readonly DocumentBundle[]> {
    const rows = this.db.select().from(documents)
      .where(eq(documents.sessionId, sessionId))
      .orderBy(asc(documents.createdAt), asc(documents.documentId)).all();
    return rows.map(row => this.readBundle(row as DocumentRow));
  }

  private readBundle(row: DocumentRow): DocumentBundle {
    try {
      const chunks = this.db.select().from(documentChunks)
        .where(eq(documentChunks.documentId, row.documentId))
        .orderBy(asc(documentChunks.ordinal)).all();
      const bundle = validateBundle({ document: toDocument(row), chunks: chunks.map(chunk => toChunk(chunk as DocumentChunkRow)) });
      const attachment = this.db.select().from(attachments)
        .where(eq(attachments.attachmentId, bundle.document.attachmentId)).limit(1).get();
      const turn = this.db.select().from(researchTurns)
        .where(eq(researchTurns.id, bundle.document.createdByTurnId)).limit(1).get();
      if (!attachment || attachment.sessionId !== bundle.document.sessionId
        || attachment.contentHash !== bundle.document.sourceContentHash
        || attachment.filename !== bundle.document.filename
        || !turn || turn.sessionId !== bundle.document.sessionId) {
        throw integrity(`Document ${row.documentId} persisted source ownership is invalid`);
      }
      return bundle;
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      throw integrity(`Document ${row.documentId} has malformed persisted rows`);
    }
  }
}
