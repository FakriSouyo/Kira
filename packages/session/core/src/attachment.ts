import type { Attachment } from '@harness/schemas';

export type { Attachment } from '@harness/schemas';

export interface AttachmentSaveInput {
  sessionId: string;
  turnId: string;
  filename: string;
  mediaType?: string | null;
  content: Uint8Array;
}

export interface AttachmentStore {
  save(input: AttachmentSaveInput): Promise<Attachment>;
  getById(attachmentId: string): Promise<Attachment | null>;
  listBySession(sessionId: string): Promise<Attachment[]>;
  listByTurn(turnId: string): Promise<Attachment[]>;
  readContent(attachmentId: string): Promise<Uint8Array>;
}

export type AttachmentStoreErrorCode =
  | 'ATTACHMENT_INVALID'
  | 'ATTACHMENT_SESSION_NOT_FOUND'
  | 'ATTACHMENT_TURN_NOT_FOUND'
  | 'ATTACHMENT_TURN_SESSION_MISMATCH'
  | 'ATTACHMENT_NOT_FOUND'
  | 'ATTACHMENT_BLOB_MISSING'
  | 'ATTACHMENT_INTEGRITY_FAILURE';

export class AttachmentStoreError extends Error {
  constructor(public readonly code: AttachmentStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AttachmentStoreError';
  }
}
