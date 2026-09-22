import { createHash } from 'node:crypto';

export const DOCUMENT_IDENTITY_SCHEMA_VERSION = 1 as const;

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function documentIdentityHash(input: {
  readonly attachmentId: string;
  readonly sourceContentHash: string;
  readonly extractorId: string;
  readonly extractorVersion: string;
}): string {
  const canonical = JSON.stringify({
    schemaVersion: DOCUMENT_IDENTITY_SCHEMA_VERSION,
    attachmentId: input.attachmentId,
    sourceContentHash: input.sourceContentHash,
    extractorId: input.extractorId,
    extractorVersion: input.extractorVersion,
  });
  return sha256Hex(canonical);
}

export function documentIdFor(input: Parameters<typeof documentIdentityHash>[0]): string {
  return `document_${documentIdentityHash(input)}`;
}

export function chunkIdFor(documentId: string, ordinal: number, contentHash: string): string {
  return `chunk_${sha256Hex(JSON.stringify({ schemaVersion: 1, documentId, ordinal, contentHash }))}`;
}
