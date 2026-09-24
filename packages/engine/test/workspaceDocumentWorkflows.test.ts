import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityGateway } from '@harness/capability';
import type { DocumentBundle, DocumentSearchHit, DocumentStore } from '@harness/document';
import type { Attachment } from '@harness/schemas';
import {
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  attachmentToolIds,
  documentIndexWorkflow,
  documentSearchWorkflow,
  documentToolIds,
  filesWorkflow,
} from '../src/index.js';

const TURN_ID = 'turn-index';
const SAVED_AT = '2026-09-25T00:00:00.000Z';

function attachment(content: Uint8Array, overrides: Partial<Attachment> = {}): Attachment {
  return {
    attachmentId: 'attachment-1',
    schemaVersion: 1,
    sessionId: 'session-1',
    turnId: 'turn-attach',
    filename: 'notes.txt',
    mediaType: 'text/plain',
    sizeBytes: content.byteLength,
    contentHash: createHash('sha256').update(content).digest('hex'),
    createdAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function gatewayReturning<T>(value: T) {
  const invoke = vi.fn(async (..._args: unknown[]) => ({ value }));
  return { gateway: { invoke } as unknown as CapabilityGateway, invoke };
}

function documentStoreSavingAsSavedBundle() {
  const save = vi.fn(async (bundle: DocumentBundle) => ({
    ...bundle,
    document: { ...bundle.document, createdAt: SAVED_AT },
  }));
  return { store: { save } as unknown as DocumentStore, save };
}

function searchHit(chunkId: string, ordinal: number): DocumentSearchHit {
  const hash = 'a'.repeat(64);
  return {
    score: ordinal + 0.5,
    text: `result ${ordinal}`,
    chunk: {
      chunkId,
      schemaVersion: 1,
      documentId: 'document-1',
      ordinal,
      text: `result ${ordinal}`,
      contentHash: hash,
      pageStart: null,
      pageEnd: null,
      lineStart: ordinal + 1,
      lineEnd: ordinal + 1,
      section: null,
    },
    citation: {
      attachmentId: 'attachment-1',
      documentId: 'document-1',
      chunkId,
      filename: 'notes.txt',
      sourceContentHash: hash,
      contentHash: hash,
      pageStart: null,
      pageEnd: null,
      lineStart: ordinal + 1,
      lineEnd: ordinal + 1,
      section: null,
    },
  };
}

describe('host-neutral Workspace and Document workflows', () => {
  it('filesWorkflow invokes the exact capability with cancellation and preserves attachment order', async () => {
    const attachments = [
      attachment(new Uint8Array(), { attachmentId: 'attachment-z', filename: 'z.txt' }),
      attachment(new Uint8Array(), { attachmentId: 'attachment-a', filename: 'a.txt' }),
    ];
    const { gateway, invoke } = gatewayReturning(attachments);
    const signal = new AbortController().signal;

    const artifacts = await filesWorkflow(gateway, { signal });

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      COMMAND_FILES_CAPABILITY_PRINCIPAL,
      attachmentToolIds.list,
      {},
      { signal },
    );
    expect(artifacts.attachments).toBe(attachments);
    expect(artifacts.attachments.map(({ attachmentId }) => attachmentId)).toEqual([
      'attachment-z', 'attachment-a',
    ]);
  });

  it('documentIndexWorkflow reads through its capability, builds through @harness/document, saves once, and returns the saved bundle', async () => {
    const content = new TextEncoder().encode('Host-neutral document content.');
    const source = attachment(content);
    const { gateway, invoke } = gatewayReturning({ attachment: source, content });
    const { store, save } = documentStoreSavingAsSavedBundle();
    const signal = new AbortController().signal;

    const saved = await documentIndexWorkflow(gateway, store, {
      attachmentId: source.attachmentId,
      createdByTurnId: TURN_ID,
      signal,
    });

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
      attachmentToolIds.read,
      { attachmentId: source.attachmentId },
      { signal },
    );
    expect(save).toHaveBeenCalledOnce();
    const bundle = save.mock.calls[0]![0];
    expect(bundle.document).toMatchObject({
      attachmentId: source.attachmentId,
      sessionId: source.sessionId,
      filename: source.filename,
      createdByTurnId: TURN_ID,
      detectedMediaType: 'text/plain',
      chunkCount: 1,
    });
    expect(bundle.chunks.map(({ text }) => text)).toEqual(['Host-neutral document content.']);
    expect(saved).toEqual({ ...bundle, document: { ...bundle.document, createdAt: SAVED_AT } });
    expect(saved).not.toBe(bundle);
  });

  it('documentIndexWorkflow propagates capability, extraction, and persistence failures', async () => {
    const readFailure = new Error('attachment read denied');
    const failedGateway = {
      invoke: vi.fn(async () => { throw readFailure; }),
    } as unknown as CapabilityGateway;
    const { store } = documentStoreSavingAsSavedBundle();
    await expect(documentIndexWorkflow(failedGateway, store, {
      attachmentId: 'attachment-1', createdByTurnId: TURN_ID,
    })).rejects.toBe(readFailure);

    const unsupportedContent = new Uint8Array([0, 1, 2]);
    const unsupportedAttachment = attachment(unsupportedContent, {
      filename: 'archive.bin',
      mediaType: 'application/octet-stream',
    });
    const { gateway: unsupportedGateway } = gatewayReturning({
      attachment: unsupportedAttachment,
      content: unsupportedContent,
    });
    const extractionStore = documentStoreSavingAsSavedBundle();
    await expect(documentIndexWorkflow(unsupportedGateway, extractionStore.store, {
      attachmentId: unsupportedAttachment.attachmentId,
      createdByTurnId: TURN_ID,
    })).rejects.toMatchObject({ code: 'DOCUMENT_UNSUPPORTED_TYPE' });
    expect(extractionStore.save).not.toHaveBeenCalled();

    const content = new TextEncoder().encode('Persistence error content.');
    const source = attachment(content);
    const { gateway } = gatewayReturning({ attachment: source, content });
    const persistenceFailure = new Error('document store unavailable');
    const failingStore = {
      save: vi.fn(async () => { throw persistenceFailure; }),
    } as unknown as DocumentStore;
    await expect(documentIndexWorkflow(gateway, failingStore, {
      attachmentId: source.attachmentId,
      createdByTurnId: TURN_ID,
    })).rejects.toBe(persistenceFailure);
  });

  it('documentSearchWorkflow invokes the exact capability and preserves query, hit order, values, and cancellation', async () => {
    const results = [searchHit('chunk-z', 0), searchHit('chunk-a', 1)];
    const { gateway, invoke } = gatewayReturning(results);
    const signal = new AbortController().signal;
    const input = { query: 'quarterly revenue', documentId: 'document-1', limit: 2, signal };

    const artifacts = await documentSearchWorkflow(gateway, input);

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
      documentToolIds.search,
      { query: input.query, documentId: input.documentId, limit: input.limit },
      { signal },
    );
    expect(artifacts).toEqual({ query: input.query, results });
    expect(artifacts.results).toBe(results);
    expect(artifacts.results.map(({ chunk }) => chunk.chunkId)).toEqual(['chunk-z', 'chunk-a']);
  });
});
