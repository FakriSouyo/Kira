import {
  DocumentSearchHitSchema,
  DocumentSearchQuerySchema,
  type Document,
  type DocumentChunk,
  type DocumentSearchHit,
  type DocumentSearchQuery,
} from '@harness/schemas';
import { DocumentError } from './errors.js';

const tokenize = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = haystack.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function normalizeQuery(input: DocumentSearchQuery): DocumentSearchQuery {
  const query = input.query.trim().replace(/\s+/g, ' ');
  if (!query) throw new DocumentError('DOCUMENT_SEARCH_INVALID', 'Document search query must not be empty');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new DocumentError('DOCUMENT_SEARCH_INVALID', 'Document search limit must be between 1 and 20');
  }
  return DocumentSearchQuerySchema.parse({ ...input, query, limit });
}

export function searchDocumentChunks(
  document: Document,
  chunks: readonly DocumentChunk[],
  input: DocumentSearchQuery,
): readonly DocumentSearchHit[] {
  const query = normalizeQuery(input);
  if (query.documentId && query.documentId !== document.documentId) return [];
  const phrase = query.query.toLowerCase();
  const queryTokens = tokenize(query.query);
  const uniqueTokens = [...new Set(queryTokens)];
  const hits = chunks.flatMap(chunk => {
    const lowerText = chunk.text.toLowerCase();
    const phraseCount = occurrences(lowerText, phrase);
    const matchedTokens = uniqueTokens.reduce((total, token) => total + (lowerText.includes(token) ? 1 : 0), 0);
    const tokenOccurrences = queryTokens.reduce((total, token) => total + occurrences(lowerText, token), 0);
    if (phraseCount === 0 && matchedTokens === 0) return [];
    const score = phraseCount * 100 + matchedTokens * 10 + tokenOccurrences;
    return [DocumentSearchHitSchema.parse({
      score,
      text: chunk.text,
      chunk,
      citation: {
        attachmentId: document.attachmentId,
        documentId: document.documentId,
        chunkId: chunk.chunkId,
        filename: document.filename,
        sourceContentHash: document.sourceContentHash,
        contentHash: chunk.contentHash,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
        section: chunk.section,
      },
    })];
  });
  return hits.sort(compareDocumentSearchHits).slice(0, query.limit);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareDocumentSearchHits(left: DocumentSearchHit, right: DocumentSearchHit): number {
  return right.score - left.score
    || compareIds(left.citation.documentId, right.citation.documentId)
    || left.chunk.ordinal - right.chunk.ordinal
    || compareIds(left.chunk.chunkId, right.chunk.chunkId);
}
