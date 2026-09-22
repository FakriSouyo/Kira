export const DOCUMENT_ERROR_CODES = [
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_UNSUPPORTED_TYPE',
  'DOCUMENT_INVALID_UTF8',
  'DOCUMENT_EXTRACTION_FAILED',
  'DOCUMENT_NO_TEXT',
  'DOCUMENT_LIMIT_EXCEEDED',
  'DOCUMENT_INTEGRITY_FAILURE',
  'DOCUMENT_SEARCH_INVALID',
] as const;

export type DocumentErrorCode = typeof DOCUMENT_ERROR_CODES[number];

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;

  constructor(code: DocumentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DocumentError';
    this.code = code;
  }
}
