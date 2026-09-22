import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { AttachmentSchema, type Attachment } from '@harness/schemas';
import { DocumentError } from './errors.js';
import { DOCUMENT_LIMITS, detectDocumentType, type DetectedDocumentType } from './detect.js';
import { sha256Hex } from './identity.js';

export interface ExtractedPage {
  readonly pageNumber: number;
  readonly text: string;
}

export interface ExtractedDocument {
  readonly detected: DetectedDocumentType;
  readonly text: string;
  readonly pages: readonly ExtractedPage[];
  readonly pageCount: number | null;
  readonly textHash: string;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function decodeUtf8(content: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch (error) {
    throw new DocumentError('DOCUMENT_INVALID_UTF8', 'The document is not valid UTF-8 text', { cause: error });
  }
}

function assertSize(content: Uint8Array): void {
  if (content.byteLength > DOCUMENT_LIMITS.maxBytes) {
    throw new DocumentError('DOCUMENT_LIMIT_EXCEEDED', `Document exceeds the ${DOCUMENT_LIMITS.maxBytes} byte limit`);
  }
}

function assertText(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length === 0 || normalized.trim().length === 0) {
    throw new DocumentError('DOCUMENT_NO_TEXT', 'The document contains no extractable text');
  }
  if (normalized.length > DOCUMENT_LIMITS.maxCharacters) {
    throw new DocumentError('DOCUMENT_LIMIT_EXCEEDED', `Document exceeds the ${DOCUMENT_LIMITS.maxCharacters} character limit`);
  }
  return normalized;
}

async function extractPdf(content: Uint8Array): Promise<{ text: string; pages: ExtractedPage[]; pageCount: number }> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    const pdfModulePath = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
    loadingTask = getDocument({
      // PDF.js may transfer its input buffer to a worker; retain the verified Attachment bytes.
      data: new Uint8Array(content),
      useWorkerFetch: false,
      useSystemFonts: false,
      standardFontDataUrl: resolve(dirname(pdfModulePath), '../../standard_fonts') + sep,
    });
    const pdf = await loadingTask.promise;
    if (pdf.numPages > DOCUMENT_LIMITS.maxPages) {
      throw new DocumentError('DOCUMENT_LIMIT_EXCEEDED', `PDF exceeds the ${DOCUMENT_LIMITS.maxPages} page limit`);
    }
    const pages: ExtractedPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        let pageText = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const textItem = item as TextItem;
          pageText += textItem.str;
          if (textItem.hasEOL) pageText += '\n';
          else if (textItem.str.length > 0) pageText += ' ';
        }
        pages.push({ pageNumber, text: normalizeText(pageText).trim() });
      } finally {
        page.cleanup();
      }
    }
    const text = assertText(pages.map(page => page.text).filter(Boolean).join('\n\n'));
    return { text, pages, pageCount: pdf.numPages };
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw new DocumentError('DOCUMENT_EXTRACTION_FAILED', 'The PDF could not be extracted', { cause: error });
  } finally {
    try {
      await loadingTask?.destroy();
    } catch {
      // Cleanup failure must not replace the extraction result or error.
    }
  }
}

export async function extractDocument(input: {
  readonly attachment: Attachment;
  readonly content: Uint8Array;
}): Promise<ExtractedDocument> {
  const attachment = AttachmentSchema.parse(input.attachment);
  const content = input.content;
  assertSize(content);
  if (attachment.sizeBytes !== content.byteLength || attachment.contentHash !== sha256Hex(content)) {
    throw new DocumentError('DOCUMENT_INTEGRITY_FAILURE', `Attachment ${attachment.attachmentId} bytes do not match its immutable metadata`);
  }
  const detected = detectDocumentType(attachment, content);

  if (detected.detectedMediaType === 'application/pdf') {
    const extracted = await extractPdf(content);
    return { detected, ...extracted, textHash: sha256Hex(extracted.text) };
  }

  const text = assertText(decodeUtf8(content));
  if (text.includes('\u0000')) {
    throw new DocumentError('DOCUMENT_UNSUPPORTED_TYPE', 'Binary content is not supported as a text document');
  }
  return {
    detected,
    text,
    pages: [{ pageNumber: 1, text }],
    pageCount: null,
    textHash: sha256Hex(text),
  };
}
