import type { DocumentChunk } from '@harness/schemas';
import { DocumentChunkSchema } from '@harness/schemas';
import { DocumentError } from './errors.js';
import { DOCUMENT_LIMITS } from './detect.js';
import { chunkIdFor, sha256Hex } from './identity.js';
import type { ExtractedDocument } from './extract.js';

type Segment = {
  readonly text: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly pageNumber: number;
  readonly section: string | null;
};

function lineForOffset(text: string, offset: number): number {
  return 1 + (text.slice(0, offset).match(/\n/g)?.length ?? 0);
}

function splitSegment(segment: Segment): Array<Omit<Segment, 'text'> & { text: string }> {
  const text = segment.text.trim();
  if (text.length <= DOCUMENT_LIMITS.maxChunkCharacters) return [{ ...segment, text }];
  const chunks: Array<Omit<Segment, 'text'> & { text: string }> = [];
  for (let offset = 0; offset < text.length; offset += DOCUMENT_LIMITS.maxChunkCharacters) {
    const part = text.slice(offset, offset + DOCUMENT_LIMITS.maxChunkCharacters).trim();
    if (!part) continue;
    const start = lineForOffset(text, offset);
    const end = lineForOffset(text, Math.min(text.length - 1, offset + part.length - 1));
    chunks.push({ ...segment, text: part, lineStart: segment.lineStart + start - 1, lineEnd: segment.lineStart + end - 1 });
  }
  return chunks;
}

function textSegments(text: string, pageNumber: number, markdown: boolean): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let section: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (markdown) {
      const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
      if (heading) {
        section = heading[2] ?? null;
        index += 1;
        continue;
      }
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const start = index;
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() !== '') {
      const current = lines[index] ?? '';
      if (markdown) {
        const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(current.trim());
        if (heading && paragraph.length > 0) break;
        if (heading) {
          section = heading[2] ?? null;
          index += 1;
          continue;
        }
      }
      paragraph.push(current);
      index += 1;
    }
    const value = paragraph.join('\n').trim();
    if (value) {
      segments.push({
        text: value,
        lineStart: start + 1,
        lineEnd: start + paragraph.length,
        pageNumber,
        section,
      });
    }
  }
  return segments;
}

export function chunkDocument(extracted: ExtractedDocument): readonly DocumentChunk[] {
  const segments = extracted.pages.flatMap(page => textSegments(
    page.text,
    page.pageNumber,
    extracted.detected.detectedMediaType === 'text/markdown',
  ));
  const expanded = segments.flatMap(splitSegment);
  if (expanded.length === 0) throw new DocumentError('DOCUMENT_NO_TEXT', 'The document contains no non-empty chunks');
  if (expanded.length > DOCUMENT_LIMITS.maxChunks) {
    throw new DocumentError('DOCUMENT_LIMIT_EXCEEDED', `Document exceeds the ${DOCUMENT_LIMITS.maxChunks} chunk limit`);
  }

  const unboundDocumentId = `unbound_${extracted.textHash}`;
  const chunks = expanded.map((segment, ordinal) => {
    const contentHash = sha256Hex(segment.text);
    return DocumentChunkSchema.parse({
      chunkId: chunkIdFor(unboundDocumentId, ordinal, contentHash),
      schemaVersion: 1,
      documentId: unboundDocumentId,
      ordinal,
      text: segment.text,
      contentHash,
      pageStart: extracted.pageCount === null ? null : segment.pageNumber,
      pageEnd: extracted.pageCount === null ? null : segment.pageNumber,
      lineStart: extracted.pageCount === null ? segment.lineStart : null,
      lineEnd: extracted.pageCount === null ? segment.lineEnd : null,
      section: segment.section,
    });
  });
  return chunks;
}

export function bindChunkDocumentId(chunks: readonly DocumentChunk[], documentId: string): readonly DocumentChunk[] {
  return chunks.map(chunk => DocumentChunkSchema.parse({
    ...chunk,
    documentId,
    chunkId: chunkIdFor(documentId, chunk.ordinal, chunk.contentHash),
  }));
}
