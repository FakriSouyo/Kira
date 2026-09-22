export * from './contracts.js';
export * from './errors.js';
export * from './detect.js';
export * from './extract.js';
export * from './chunk.js';
export * from './identity.js';
export * from './retrieval.js';

import { DocumentSchema } from '@harness/schemas';
import type { DocumentBundle, DocumentBundleInput } from './contracts.js';
import { chunkDocument, bindChunkDocumentId } from './chunk.js';
import { extractDocument } from './extract.js';
import { documentIdFor } from './identity.js';

export async function buildDocumentBundle(input: DocumentBundleInput): Promise<DocumentBundle> {
  const extracted = await extractDocument(input);
  const documentId = documentIdFor({
    attachmentId: input.attachment.attachmentId,
    sourceContentHash: input.attachment.contentHash,
    extractorId: extracted.detected.extractorId,
    extractorVersion: extracted.detected.extractorVersion,
  });
  const chunks = bindChunkDocumentId(chunkDocument(extracted), documentId);
  const document = DocumentSchema.parse({
    documentId,
    schemaVersion: 1,
    sessionId: input.attachment.sessionId,
    attachmentId: input.attachment.attachmentId,
    sourceContentHash: input.attachment.contentHash,
    filename: input.attachment.filename,
    detectedMediaType: extracted.detected.detectedMediaType,
    extractorId: extracted.detected.extractorId,
    extractorVersion: extracted.detected.extractorVersion,
    textHash: extracted.textHash,
    pageCount: extracted.pageCount,
    chunkCount: chunks.length,
    createdByTurnId: input.createdByTurnId,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  return { document, chunks };
}
