import { describe, expect, it, vi } from 'vitest';
import type { Document, DocumentBundle, DocumentChunk, DocumentStore } from '@harness/document';
import type { FinancialDataProvider } from '@harness/financial-data';
import {
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  createEngineCapabilityRuntime,
  documentToolIds,
  financialToolIds,
  JUDGE_CAPABILITY_PRINCIPALS,
  SCREEN_CAPABILITY_PRINCIPAL,
  attachmentToolIds,
} from '@harness/engine';

function documentBundle(documentId: string, sessionId: string): DocumentBundle {
  const document: Document = {
    documentId,
    schemaVersion: 1,
    sessionId,
    attachmentId: 'attachment',
    sourceContentHash: '0'.repeat(64),
    filename: 'report.txt',
    detectedMediaType: 'text/plain',
    extractorId: 'builtin-text',
    extractorVersion: '1',
    textHash: '0'.repeat(64),
    pageCount: null,
    chunkCount: 0,
    createdByTurnId: 'turn',
    createdAt: '2026-09-22T00:00:00.000Z',
  };
  const chunks: DocumentChunk[] = [];
  return { document, chunks };
}

function runtimeFor(store: DocumentStore) {
  return createEngineCapabilityRuntime({
    financialData: {} as FinancialDataProvider,
    attachmentStore: {} as never,
    documentStore: store,
    sessionId: 'trusted-document-session',
  });
}

function documentStore(overrides: Partial<DocumentStore> = {}): DocumentStore {
  return {
    save: async bundle => bundle,
    getById: async () => null,
    getByAttachment: async () => null,
    listBySession: async () => [],
    ...overrides,
  };
}

describe('document capability authority', () => {
  it('registers document.search under document-store without exposing trusted Session scope', () => {
    const { capabilityGateway } = runtimeFor(documentStore());
    const document = capabilityGateway.describe(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search);

    expect(document).toMatchObject({ id: documentToolIds.search, integrationId: 'document-store', kind: 'tool' });
    expect(document).not.toHaveProperty('sessionId');
    expect(document).not.toHaveProperty('tool');
  });

  it('grants doc-index only attachment.read and doc-search only document.search', () => {
    const { capabilityGateway: gateway } = runtimeFor(documentStore());

    expect(gateway.list(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([attachmentToolIds.read]);
    expect(gateway.list(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([documentToolIds.search]);
    expect(gateway.list(COMMAND_FILES_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([attachmentToolIds.list]);
    expect(gateway.describe(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read).id).toBe(attachmentToolIds.read);
    expect(gateway.describe(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search).id).toBe(documentToolIds.search);
    expect(gateway.describe(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentToolIds.list).id).toBe(attachmentToolIds.list);
    expect(() => gateway.describe(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.list))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => gateway.describe(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.describe))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    expect(() => gateway.describe(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, documentToolIds.search))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    for (const attachmentId of Object.values(attachmentToolIds)) {
      expect(() => gateway.describe(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, attachmentId))
        .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    }
    for (const attachmentId of [attachmentToolIds.describe, attachmentToolIds.read]) {
      expect(() => gateway.describe(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentId))
        .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    }
    expect(() => gateway.describe(COMMAND_FILES_CAPABILITY_PRINCIPAL, documentToolIds.search))
      .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    for (const financialId of Object.values(financialToolIds)) {
      for (const principal of [COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, COMMAND_FILES_CAPABILITY_PRINCIPAL]) {
        expect(() => gateway.describe(principal, financialId))
          .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
      }
    }
  });

  it('denies document capabilities to command.screen and every workflow.judge.* principal', () => {
    const { capabilityGateway: gateway } = runtimeFor(documentStore());
    for (const principal of [SCREEN_CAPABILITY_PRINCIPAL, ...Object.values(JUDGE_CAPABILITY_PRINCIPALS)]) {
      expect(() => gateway.describe(principal, documentToolIds.search))
        .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    }
  });

  it('fails closed on a cross-Session document lookup and rejects caller-controlled scope', async () => {
    const getById = vi.fn(async () => documentBundle('document-other', 'other-session'));
    const listBySession = vi.fn(async (sessionId: string) =>
      sessionId === 'trusted-document-session' ? [] : [documentBundle('document-other', 'other-session')]);
    const { capabilityGateway } = runtimeFor(documentStore({ getById, listBySession }));

    await expect(capabilityGateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, {
      query: 'secret',
      documentId: 'document-other',
    })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(capabilityGateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, {
      query: 'secret',
      sessionId: 'other-session',
    })).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
});
