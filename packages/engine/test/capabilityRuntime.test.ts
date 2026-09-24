import { describe, expect, it, vi } from 'vitest';
import { createEngineCapabilityRuntime } from '../src/index';
import {
  attachmentToolIds,
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
  documentToolIds,
  financialToolIds,
  JUDGE_CAPABILITY_PRINCIPALS,
  SCREEN_CAPABILITY_PRINCIPAL,
} from '../src/index';
import type { Attachment, AttachmentStore } from '@harness/session-core';
import type { Document, DocumentBundle, DocumentChunk, DocumentStore } from '@harness/document';
import type { FinancialDataProvider } from '@harness/financial-data';
import { ToolRuntime } from '@harness/tool-runtime';
import { createAttachmentTools } from '../src/tools/attachment';

const SESSION_ID = 'session-trusted';

function attachment(attachmentId: string, sessionId: string): Attachment {
  return {
    attachmentId,
    schemaVersion: 1,
    sessionId,
    turnId: `turn-${sessionId}`,
    filename: `${attachmentId}.txt`,
    mediaType: 'text/plain',
    sizeBytes: 4,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-09-24T00:00:00.000Z',
  };
}

function documentBundle(documentId: string, sessionId: string, text: string): DocumentBundle {
  const document: Document = {
    documentId,
    schemaVersion: 1,
    sessionId,
    attachmentId: `attachment-${documentId}`,
    sourceContentHash: 'b'.repeat(64),
    filename: `${documentId}.txt`,
    detectedMediaType: 'text/plain',
    extractorId: 'builtin-text',
    extractorVersion: '1',
    textHash: 'c'.repeat(64),
    pageCount: null,
    chunkCount: 1,
    createdByTurnId: `turn-${sessionId}`,
    createdAt: '2026-09-24T00:00:00.000Z',
  };
  const chunk: DocumentChunk = {
    chunkId: `chunk-${documentId}`,
    schemaVersion: 1,
    documentId,
    ordinal: 0,
    text,
    contentHash: 'd'.repeat(64),
    pageStart: null,
    pageEnd: null,
    lineStart: 1,
    lineEnd: 1,
    section: null,
  };
  return { document, chunks: [chunk] };
}

function makeAttachmentStore(rows: readonly Attachment[], contents: ReadonlyMap<string, Uint8Array>) {
  const getById = vi.fn(async (attachmentId: string) => rows.find(row => row.attachmentId === attachmentId) ?? null);
  const listBySession = vi.fn(async (sessionId: string) => rows.filter(row => row.sessionId === sessionId));
  const readContent = vi.fn(async (attachmentId: string) => {
    const content = contents.get(attachmentId);
    if (!content) throw new Error(`Missing fake content for ${attachmentId}`);
    return content;
  });
  const store: AttachmentStore = {
    save: async () => { throw new Error('save is not used by capability tools'); },
    getById,
    listBySession,
    listByTurn: async () => [],
    readContent,
  };
  return { store, getById, listBySession, readContent };
}

function makeDocumentStore(rows: readonly DocumentBundle[]) {
  const getById = vi.fn(async (documentId: string) => rows.find(row => row.document.documentId === documentId) ?? null);
  const listBySession = vi.fn(async (sessionId: string) => rows.filter(row => row.document.sessionId === sessionId));
  const store: DocumentStore = {
    save: async bundle => bundle,
    getById,
    getByAttachment: async () => null,
    listBySession,
  };
  return { store, getById, listBySession };
}

function runtimeFor(input: {
  readonly sessionId?: string;
  readonly financialData?: FinancialDataProvider;
  readonly attachments?: readonly Attachment[];
  readonly attachmentContents?: ReadonlyMap<string, Uint8Array>;
  readonly documents?: readonly DocumentBundle[];
} = {}) {
  const financialData = input.financialData ?? {
    screen: vi.fn(async () => [{ ticker: 'BBCA', matchScore: 1 }]),
  } as unknown as FinancialDataProvider;
  const attachments = makeAttachmentStore(input.attachments ?? [], input.attachmentContents ?? new Map());
  const documents = makeDocumentStore(input.documents ?? []);
  const runtime = createEngineCapabilityRuntime({
    financialData,
    attachmentStore: attachments.store,
    documentStore: documents.store,
    sessionId: input.sessionId ?? SESSION_ID,
  });
  return { ...runtime, financialData, attachments, documents };
}

describe('host-neutral capability runtime', () => {
  it('registers current financial, attachment, and document capabilities with exact least-privilege grants', async () => {
    const { capabilityGateway: gateway } = runtimeFor();

    expect(gateway.list(SCREEN_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([financialToolIds.screen]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.identifyCompany).map(({ id }) => id)).toEqual([financialToolIds.companyReport]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchFinancials).map(({ id }) => id)).toEqual([financialToolIds.quarterlyFinancials]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchMarketData).map(({ id }) => id)).toEqual([
      financialToolIds.dailyTransaction,
      financialToolIds.foreignFlow,
    ]);
    expect(gateway.list(JUDGE_CAPABILITY_PRINCIPALS.fetchNews).map(({ id }) => id)).toEqual([
      financialToolIds.filings,
      financialToolIds.news,
      financialToolIds.sentiment,
    ]);
    expect(gateway.list(COMMAND_FILES_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([attachmentToolIds.list]);
    expect(gateway.list(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([attachmentToolIds.read]);
    expect(gateway.list(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL).map(({ id }) => id)).toEqual([documentToolIds.search]);

    const listedIds = [
      SCREEN_CAPABILITY_PRINCIPAL,
      ...Object.values(JUDGE_CAPABILITY_PRINCIPALS),
      COMMAND_FILES_CAPABILITY_PRINCIPAL,
      COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
      COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
    ].flatMap(principal => gateway.list(principal).map(({ id }) => id));
    expect([...listedIds].sort()).toEqual([
      ...Object.values(financialToolIds),
      attachmentToolIds.list,
      attachmentToolIds.read,
      documentToolIds.search,
    ].sort());

    for (const financialId of Object.values(financialToolIds).filter(id => id !== financialToolIds.screen)) {
      await expect(gateway.invoke(SCREEN_CAPABILITY_PRINCIPAL, financialId, { ticker: 'BBCA' }))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    }
    for (const principal of [
      SCREEN_CAPABILITY_PRINCIPAL,
      ...Object.values(JUDGE_CAPABILITY_PRINCIPALS),
      COMMAND_FILES_CAPABILITY_PRINCIPAL,
      COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
      COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL,
    ]) {
      await expect(gateway.invoke(principal, attachmentToolIds.describe, { attachmentId: 'attachment-1' }))
        .rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    }
  });

  it('invokes the supplied financial provider through the Screen capability', async () => {
    const screen = vi.fn(async (criteria: string[]) => [{ ticker: 'BBCA', matchScore: criteria.length }]);
    const financialData = { screen } as unknown as FinancialDataProvider;
    const { capabilityGateway } = runtimeFor({ financialData });

    await expect(capabilityGateway.invoke(SCREEN_CAPABILITY_PRINCIPAL, financialToolIds.screen, { criteria: ['profitable'] }))
      .resolves.toMatchObject({ value: [{ ticker: 'BBCA', matchScore: 1 }] });
    expect(screen).toHaveBeenCalledWith(['profitable']);
  });

  it('keeps attachment tools scoped to their trusted Session and fails closed before reading foreign bytes', async () => {
    const own = attachment('attachment-own', SESSION_ID);
    const foreign = attachment('attachment-foreign', 'session-other');
    const ownContent = new Uint8Array([1, 2, 3, 4]);
    const attachmentContents = new Map([[own.attachmentId, ownContent], [foreign.attachmentId, new Uint8Array([9])]]);
    const { capabilityGateway, attachments } = runtimeFor({ attachments: [own, foreign], attachmentContents });

    await expect(capabilityGateway.invoke(COMMAND_FILES_CAPABILITY_PRINCIPAL, attachmentToolIds.list, {}))
      .resolves.toMatchObject({ value: [own] });
    expect(attachments.listBySession).toHaveBeenCalledWith(SESSION_ID);
    await expect(capabilityGateway.invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: own.attachmentId }))
      .resolves.toMatchObject({ value: { attachment: own, content: ownContent } });
    await expect(capabilityGateway.invoke(COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL, attachmentToolIds.read, { attachmentId: foreign.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(attachments.readContent).toHaveBeenCalledTimes(1);
  });

  it('keeps document search Session-scoped for list and explicit document lookups', async () => {
    const own = documentBundle('document-own', SESSION_ID, 'Revenue grew during the quarter.');
    const foreign = documentBundle('document-foreign', 'session-other', 'Revenue declined during the quarter.');
    const { capabilityGateway, documents } = runtimeFor({ documents: [own, foreign] });

    const results = await capabilityGateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, { query: 'revenue' });
    expect(results.value.map(hit => hit.citation.documentId)).toEqual([own.document.documentId]);
    expect(documents.listBySession).toHaveBeenCalledWith(SESSION_ID);
    await expect(capabilityGateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, {
      query: 'revenue',
      documentId: foreign.document.documentId,
    })).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(capabilityGateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, {
      query: 'revenue',
      sessionId: 'session-other',
    })).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });

  it('keeps the Judge capability plan identical to the audited pre-extraction baseline', () => {
    const { judgeCapabilityPlan } = runtimeFor();

    expect(judgeCapabilityPlan.principals.map(({ principalId }) => principalId)).toEqual([
      'workflow.judge.fetch-financials',
      'workflow.judge.fetch-market-data',
      'workflow.judge.fetch-news',
      'workflow.judge.identify-company',
    ]);
    expect(judgeCapabilityPlan.fingerprint).toBe('520f35cdbe2c9ebcc8d34c8095a911a1a940a47e619d1f5111281d828f1dcc73');
  });

  it('keeps direct attachment description lookup Session-scoped inside the package', async () => {
    const own = attachment('attachment-own', SESSION_ID);
    const foreign = attachment('attachment-foreign', 'session-other');
    const { store, readContent } = makeAttachmentStore([own, foreign], new Map());
    const tools = createAttachmentTools({ attachmentStore: store, sessionId: SESSION_ID });
    const toolRuntime = new ToolRuntime();

    await expect(toolRuntime.invoke(tools.describe, { attachmentId: own.attachmentId })).resolves.toMatchObject({ value: own });
    await expect(toolRuntime.invoke(tools.describe, { attachmentId: foreign.attachmentId }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_NOT_FOUND' });
    expect(readContent).not.toHaveBeenCalled();
  });
});
