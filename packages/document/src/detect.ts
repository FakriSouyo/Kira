import type { Attachment } from '@harness/schemas';
import { DocumentError } from './errors.js';

export const DOCUMENT_LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxCharacters: 1_000_000,
  maxChunks: 10_000,
  maxPages: 1_000,
  maxChunkCharacters: 2_000,
});

// Bump the pipeline version whenever extraction, normalization, or chunking semantics change.
export const DOCUMENT_PIPELINE_VERSION = 'pipeline-v1' as const;
export const PDFJS_VERSION = '4.10.38' as const;
export const PDF_EXTRACTOR_ID = 'pdfjs-dist' as const;
export const PDF_EXTRACTOR_VERSION = `${PDF_EXTRACTOR_ID}@${PDFJS_VERSION}+${DOCUMENT_PIPELINE_VERSION}` as const;
export const TEXT_EXTRACTOR_ID = 'builtin-text' as const;
export const TEXT_EXTRACTOR_VERSION = DOCUMENT_PIPELINE_VERSION;

export type DetectedDocumentType = {
  readonly detectedMediaType: 'application/pdf' | 'text/plain' | 'text/markdown' | 'application/json' | 'text/csv' | 'text/tab-separated-values';
  readonly extractorId: string;
  readonly extractorVersion: string;
};

const extension = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
};

export function detectDocumentType(attachment: Pick<Attachment, 'filename' | 'mediaType'>, content: Uint8Array): DetectedDocumentType {
  const mediaType = attachment.mediaType?.toLowerCase() ?? null;
  const ext = extension(attachment.filename);

  const pdfMagic = content.byteLength >= 5
    && content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44
    && content[3] === 0x46 && content[4] === 0x2d;

  if (pdfMagic || mediaType === 'application/pdf' || (!mediaType && ext === 'pdf')) {
    return { detectedMediaType: 'application/pdf', extractorId: PDF_EXTRACTOR_ID, extractorVersion: PDF_EXTRACTOR_VERSION };
  }
  if (mediaType === 'text/markdown' || (!mediaType && (ext === 'md' || ext === 'markdown'))) {
    return { detectedMediaType: 'text/markdown', extractorId: TEXT_EXTRACTOR_ID, extractorVersion: TEXT_EXTRACTOR_VERSION };
  }
  if (mediaType === 'application/json' || (!mediaType && ext === 'json')) {
    return { detectedMediaType: 'application/json', extractorId: TEXT_EXTRACTOR_ID, extractorVersion: TEXT_EXTRACTOR_VERSION };
  }
  if (mediaType === 'text/csv' || (!mediaType && ext === 'csv')) {
    return { detectedMediaType: 'text/csv', extractorId: TEXT_EXTRACTOR_ID, extractorVersion: TEXT_EXTRACTOR_VERSION };
  }
  if (mediaType === 'text/tab-separated-values' || (!mediaType && ext === 'tsv')) {
    return { detectedMediaType: 'text/tab-separated-values', extractorId: TEXT_EXTRACTOR_ID, extractorVersion: TEXT_EXTRACTOR_VERSION };
  }
  if (mediaType === 'text/plain' || (!mediaType && (ext === '' || ext === 'txt' || ext === 'text'))) {
    return { detectedMediaType: 'text/plain', extractorId: TEXT_EXTRACTOR_ID, extractorVersion: TEXT_EXTRACTOR_VERSION };
  }

  throw new DocumentError(
    'DOCUMENT_UNSUPPORTED_TYPE',
    `Unsupported document type for ${attachment.filename}`,
  );
}
