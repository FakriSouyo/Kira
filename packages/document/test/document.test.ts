import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  DocumentError,
  PDF_EXTRACTOR_VERSION,
  PDFJS_VERSION,
  buildDocumentBundle,
  documentIdFor,
  searchDocumentChunks,
} from '../src/index.js';

const attachment = {
  attachmentId: 'attachment_text_1',
  schemaVersion: 1 as const,
  sessionId: 'session_document_1',
  turnId: 'turn_attach_1',
  filename: 'research.md',
  mediaType: 'text/markdown',
  sizeBytes: 0,
  contentHash: '0'.repeat(64),
  createdAt: '2026-09-22T00:00:00.000Z',
};

function tinyPdf(textless = false): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    textless ? '<< /Length 0 >>\nstream\n\nendstream' : '<< /Length 46 >>\nstream\nBT /F1 18 Tf 72 720 Td (Page one) Tj ET\nendstream',
    textless ? '<< /Length 0 >>\nstream\n\nendstream' : '<< /Length 46 >>\nstream\nBT /F1 18 Tf 72 720 Td (Page two) Tj ET\nendstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) body += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

type AttachmentOverrides = Omit<Partial<typeof attachment>, 'mediaType'> & { mediaType?: string | null };

function source(content: Uint8Array, overrides: AttachmentOverrides = {}) {
  return {
    ...attachment,
    filename: 'source.txt',
    mediaType: null,
    ...overrides,
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}

async function build(content: Uint8Array, overrides: AttachmentOverrides = {}) {
  return buildDocumentBundle({ attachment: source(content, overrides), content, createdByTurnId: 'turn_index_1', createdAt: '2026-09-22T00:01:00.000Z' });
}

describe('document understanding domain', () => {
  it('builds immutable deterministic identity, hashes, line provenance, and markdown sections', async () => {
    const content = new TextEncoder().encode('# Thesis\n\nRevenue grew strongly.\n\n## Risk\n\nDebt remains high.');
    const sourceContentHash = createHash('sha256').update(content).digest('hex');
    const result = await buildDocumentBundle({
      attachment: { ...attachment, sizeBytes: content.byteLength, contentHash: sourceContentHash },
      content,
      createdByTurnId: 'turn_index_1',
      createdAt: '2026-09-22T00:01:00.000Z',
    });

    expect(result.document.documentId).toBe(
      (await buildDocumentBundle({
        attachment: { ...attachment, sizeBytes: content.byteLength, contentHash: sourceContentHash },
        content,
        createdByTurnId: 'turn_index_1',
        createdAt: '2026-09-22T00:01:00.000Z',
      })).document.documentId,
    );
    expect(result.document).toMatchObject({
      schemaVersion: 1,
      sessionId: attachment.sessionId,
      attachmentId: attachment.attachmentId,
      sourceContentHash,
      filename: 'research.md',
      detectedMediaType: 'text/markdown',
      extractorId: 'builtin-text',
      extractorVersion: 'pipeline-v1',
      pageCount: null,
      chunkCount: result.chunks.length,
      createdByTurnId: 'turn_index_1',
    });
    expect(result.document).not.toHaveProperty('content');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every(chunk => chunk.text.length > 0)).toBe(true);
    expect(result.chunks.map(chunk => chunk.ordinal)).toEqual(result.chunks.map((_, index) => index));
    expect(result.chunks.map(chunk => chunk.section)).toEqual(['Thesis', 'Risk']);
    expect(result.chunks[0]).toMatchObject({ lineStart: 3, lineEnd: 3, pageStart: null, pageEnd: null });
    expect(result.chunks[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.document.textHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid UTF-8 and unsupported binary content without truncating it', async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    await expect(buildDocumentBundle({
      attachment: { ...attachment, filename: 'bad.txt', mediaType: 'text/plain', sizeBytes: 2, contentHash: createHash('sha256').update(invalidUtf8).digest('hex') },
      content: invalidUtf8,
      createdByTurnId: 'turn_index_1',
    })).rejects.toMatchObject({ code: 'DOCUMENT_INVALID_UTF8' });

    await expect(buildDocumentBundle({
      attachment: { ...attachment, filename: 'archive.bin', mediaType: 'application/octet-stream', sizeBytes: 3, contentHash: createHash('sha256').update(new Uint8Array([0, 1, 2])).digest('hex') },
      content: new Uint8Array([0, 1, 2]),
      createdByTurnId: 'turn_index_1',
    })).rejects.toMatchObject({ code: 'DOCUMENT_UNSUPPORTED_TYPE' });
  });

  it('extracts PDF pages independently and keeps page provenance on every chunk', async () => {
    const content = tinyPdf();
    const sourceContentHash = createHash('sha256').update(content).digest('hex');
    const result = await buildDocumentBundle({
      attachment: { ...attachment, filename: 'tiny.pdf', mediaType: 'application/pdf', sizeBytes: content.byteLength, contentHash: sourceContentHash },
      content,
      createdByTurnId: 'turn_index_1',
    });

    expect(result.document).toMatchObject({ detectedMediaType: 'application/pdf', pageCount: 2, chunkCount: 2 });
    expect(result.chunks.map(chunk => chunk.text)).toEqual(['Page one', 'Page two']);
    expect(result.chunks.map(chunk => [chunk.pageStart, chunk.pageEnd])).toEqual([[1, 1], [2, 2]]);
    expect(result.chunks.every(chunk => chunk.lineStart === null && chunk.lineEnd === null)).toBe(true);
  });

  it('prioritizes verified PDF magic over a misleading filename or media type and loads standard fonts locally', async () => {
    const content = tinyPdf();
    const warning = vi.spyOn(console, 'warn');
    try {
      const byFilename = await build(content, { filename: 'misleading.txt', mediaType: null });
      expect(content.byteLength).toBeGreaterThan(0);
      const byMediaType = await build(content, { filename: 'misleading.txt', mediaType: 'text/plain' });
      expect(byFilename.document.detectedMediaType).toBe('application/pdf');
      expect(byMediaType.document.detectedMediaType).toBe('application/pdf');
      const installed = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'), 'utf8')) as { version: string };
      const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: { 'pdfjs-dist': string } };
      expect(declared.dependencies['pdfjs-dist']).toBe(installed.version);
      expect(PDFJS_VERSION).toBe(installed.version);
      expect(PDF_EXTRACTOR_VERSION).toBe(`pdfjs-dist@${installed.version}+pipeline-v1`);
      expect(byFilename.document.extractorVersion).toBe(PDF_EXTRACTOR_VERSION);
      expect(byFilename.chunks.map(chunk => chunk.text)).toEqual(['Page one', 'Page two']);
      expect(warning.mock.calls.flat().join(' ')).not.toContain('standardFontDataUrl');
    } finally {
      warning.mockRestore();
    }
  });

  it('routes a malformed .pdf through extraction and reports textless PDFs separately', async () => {
    await expect(build(new TextEncoder().encode('not a PDF'), { filename: 'malformed.pdf' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_EXTRACTION_FAILED' });
    await expect(build(tinyPdf(true), { filename: 'empty.pdf' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_NO_TEXT' });
  });

  it('normalizes line endings and retains normalized line and Markdown section provenance', async () => {
    const result = await build(new TextEncoder().encode('# Thesis\r\n\r\nCapital expenditure\rrose.\r\n\r\n## Risk\rDebt rises.'), { filename: 'notes.md' });
    expect(result.chunks.map(chunk => [chunk.text, chunk.lineStart, chunk.lineEnd, chunk.section])).toEqual([
      ['Capital expenditure\nrose.', 3, 4, 'Thesis'],
      ['Debt rises.', 7, 7, 'Risk'],
    ]);
  });

  it.each([
    ['data.json', '{"capital":1}', 'application/json'],
    ['data.csv', 'capital,expenditure\n1,2', 'text/csv'],
    ['data.tsv', 'capital\texpenditure\n1\t2', 'text/tab-separated-values'],
    ['notes.txt', 'capital expenditure', 'text/plain'],
  ])('treats %s as bounded UTF-8 text', async (filename, text, detectedMediaType) => {
    const result = await build(new TextEncoder().encode(text), { filename });
    expect(result.document.detectedMediaType).toBe(detectedMediaType);
    expect(result.chunks.map(chunk => chunk.text).join('\n')).toContain(text.split('\n')[0]);
  });

  it('rejects empty text, invalid UTF-8, binary text, and size/character limits', async () => {
    await expect(build(new TextEncoder().encode(' \r\n '))).rejects.toMatchObject({ code: 'DOCUMENT_NO_TEXT' });
    await expect(build(new Uint8Array([0xc3, 0x28]))).rejects.toMatchObject({ code: 'DOCUMENT_INVALID_UTF8' });
    await expect(build(new Uint8Array([65, 0, 66]))).rejects.toMatchObject({ code: 'DOCUMENT_UNSUPPORTED_TYPE' });
    await expect(build(new TextEncoder().encode('a'.repeat(1_000_001)))).rejects.toMatchObject({ code: 'DOCUMENT_LIMIT_EXCEEDED' });
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
    await expect(build(oversized)).rejects.toMatchObject({ code: 'DOCUMENT_LIMIT_EXCEEDED' });
  });

  it('makes document and chunk identity stable for the same source and distinct for another attachment or pipeline version', async () => {
    const content = new TextEncoder().encode('capital expenditure\n\ncapital efficiency');
    const first = await build(content);
    const repeated = await build(content);
    const otherAttachment = await build(content, { attachmentId: 'attachment_text_2' });
    expect(repeated.document.documentId).toBe(first.document.documentId);
    expect(repeated.chunks.map(chunk => chunk.chunkId)).toEqual(first.chunks.map(chunk => chunk.chunkId));
    expect(otherAttachment.document.documentId).not.toBe(first.document.documentId);
    expect(otherAttachment.chunks.map(chunk => chunk.chunkId)).not.toEqual(first.chunks.map(chunk => chunk.chunkId));
    expect(documentIdFor({
      attachmentId: first.document.attachmentId,
      sourceContentHash: first.document.sourceContentHash,
      extractorId: first.document.extractorId,
      extractorVersion: 'pipeline-v2',
    })).not.toBe(first.document.documentId);
  });

  it('fails closed when the source hash does not match the bytes', async () => {
    const content = new TextEncoder().encode('source');
    await expect(buildDocumentBundle({
      attachment: { ...attachment, filename: 'source.txt', mediaType: 'text/plain', sizeBytes: content.byteLength, contentHash: '3'.repeat(64) },
      content,
      createdByTurnId: 'turn_index_1',
    })).rejects.toMatchObject({ code: 'DOCUMENT_INTEGRITY_FAILURE' });
  });

  it('retrieves exact phrases and token coverage with stable ties and citations', async () => {
    const content = new TextEncoder().encode('valuation margin\n\nvaluation margin and growth');
    const sourceContentHash = createHash('sha256').update(content).digest('hex');
    const bundle = await buildDocumentBundle({
      attachment: { ...attachment, filename: 'notes.txt', mediaType: 'text/plain', sizeBytes: content.byteLength, contentHash: sourceContentHash },
      content,
      createdByTurnId: 'turn_index_1',
    });
    const hits = searchDocumentChunks(bundle.document, bundle.chunks, { query: 'valuation margin', limit: 20 });

    expect(hits).toHaveLength(2);
    expect(hits[0]?.text).toBe('valuation margin');
    expect(hits[0]?.citation).toMatchObject({
      attachmentId: attachment.attachmentId,
      documentId: bundle.document.documentId,
      chunkId: bundle.chunks[0]?.chunkId,
      filename: bundle.document.filename,
      sourceContentHash,
    });
    expect(hits[0]?.score).toBe(hits[1]?.score);
    expect(() => searchDocumentChunks(bundle.document, bundle.chunks, { query: '   ' })).toThrowError(
      expect.objectContaining({ code: 'DOCUMENT_SEARCH_INVALID' }),
    );
  });

  it('uses hard splits for pathological paragraphs and enforces the result limit', async () => {
    const content = new TextEncoder().encode('x'.repeat(5000));
    const sourceContentHash = createHash('sha256').update(content).digest('hex');
    const bundle = await buildDocumentBundle({
      attachment: { ...attachment, filename: 'long.txt', mediaType: 'text/plain', sizeBytes: content.byteLength, contentHash: sourceContentHash },
      content,
      createdByTurnId: 'turn_index_1',
    });
    expect(bundle.chunks.length).toBeGreaterThan(2);
    expect(bundle.chunks.every(chunk => chunk.text.length <= 2000)).toBe(true);
    expect(searchDocumentChunks(bundle.document, bundle.chunks, { query: 'x', limit: 1 })).toHaveLength(1);
  });

  it('exposes structured document error codes', () => {
    expect(new DocumentError('DOCUMENT_NO_TEXT', 'no text').code).toBe('DOCUMENT_NO_TEXT');
  });
});
