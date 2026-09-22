import type {
  Attachment,
  Document,
  DocumentChunk,
} from '@harness/schemas';

export interface DocumentBundleInput {
  readonly attachment: Attachment;
  readonly content: Uint8Array;
  readonly createdByTurnId: string;
  readonly createdAt?: string;
}

export interface DocumentBundle {
  readonly document: Document;
  readonly chunks: readonly DocumentChunk[];
}

export interface DocumentStore {
  save(bundle: DocumentBundle): Promise<DocumentBundle>;
  getById(documentId: string): Promise<DocumentBundle | null>;
  getByAttachment(source: { attachmentId: string; extractorId: string; extractorVersion: string }): Promise<DocumentBundle | null>;
  listBySession(sessionId: string): Promise<readonly DocumentBundle[]>;
}

export type { Document, DocumentChunk, DocumentSearchHit, DocumentSearchQuery } from '@harness/schemas';
