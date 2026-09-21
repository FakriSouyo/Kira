import { describe, expect, it } from 'vitest';
import { ATTACHMENT_SCHEMA_VERSION, AttachmentSchema } from '../src/attachment.js';

const VALID_ATTACHMENT = {
  attachmentId: 'attachment_123',
  schemaVersion: ATTACHMENT_SCHEMA_VERSION,
  sessionId: 'session_123',
  turnId: 'turn_123',
  filename: 'report.pdf',
  mediaType: null,
  sizeBytes: 4,
  contentHash: 'a'.repeat(64),
  createdAt: '2026-09-22T00:00:00.000Z',
};

describe('AttachmentSchema', () => {
  it('accepts the versioned raw-file identity and metadata contract', () => {
    expect(AttachmentSchema.parse(VALID_ATTACHMENT)).toEqual(VALID_ATTACHMENT);
  });

  it('rejects invalid size, hash, and timestamp values', () => {
    expect(() => AttachmentSchema.parse({ ...VALID_ATTACHMENT, sizeBytes: -1 })).toThrow();
    expect(() => AttachmentSchema.parse({ ...VALID_ATTACHMENT, contentHash: 'not-a-sha256' })).toThrow();
    expect(() => AttachmentSchema.parse({ ...VALID_ATTACHMENT, createdAt: 'not-a-date' })).toThrow();
  });
});
