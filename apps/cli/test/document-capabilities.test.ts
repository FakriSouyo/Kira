import { describe, expect, it } from 'vitest';
import { CapabilityGateway } from '@harness/capability';
import type { FinancialDataProvider } from '@harness/financial-data';
import { ToolRuntime } from '@harness/tool-runtime';
import { createAttachmentTools, attachmentToolIds } from '../src/tools/attachmentTools';
import { createDocumentTools, documentToolIds } from '../src/tools/documentTools';
import {
  COMMAND_DOC_INDEX_CAPABILITY_PRINCIPAL,
  COMMAND_FILES_CAPABILITY_PRINCIPAL,
} from '../src/tools/attachmentCapabilities';
import { COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL } from '../src/tools/documentCapabilities';
import { JUDGE_CAPABILITY_PRINCIPALS, SCREEN_CAPABILITY_PRINCIPAL } from '../src/tools/financialCapabilities';
import { createFinancialTools, financialToolIds } from '../src/tools/financialTools';
import { createApplicationCapabilityGateway, createApplicationCapabilityRegistrations } from '../src/tools/applicationCapabilities';

function gatewayFor(store: { getById: () => Promise<null>; listBySession: () => Promise<[]> }) {
  const sessionId = 'trusted-document-session';
  const financialTools = createFinancialTools({} as FinancialDataProvider);
  const attachmentTools = createAttachmentTools({ attachmentStore: {} as never, sessionId });
  const documentTools = createDocumentTools({ documentStore: store as never, sessionId });
  return createApplicationCapabilityGateway({
    financialTools,
    attachmentTools,
    documentTools,
    toolRuntime: new ToolRuntime(),
  });
}

describe('document capability authority', () => {
  it('registers document.search under document-store without exposing trusted Session scope', () => {
    const tools = createDocumentTools({ documentStore: {} as never, sessionId: 'trusted-session' });
    const registrations = createApplicationCapabilityRegistrations({
      financialTools: createFinancialTools({} as FinancialDataProvider),
      attachmentTools: createAttachmentTools({ attachmentStore: {} as never, sessionId: 'trusted-session' }),
      documentTools: tools,
    });
    const document = registrations.find(({ descriptor }) => descriptor.id === documentToolIds.search)?.descriptor;

    expect(document).toMatchObject({ id: documentToolIds.search, integrationId: 'document-store', kind: 'tool' });
    expect(document).not.toHaveProperty('sessionId');
    expect(document).not.toHaveProperty('tool');
  });

  it('grants doc-index only attachment.read and doc-search only document.search', () => {
    const gateway = gatewayFor({ getById: async () => null, listBySession: async () => [] });

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
    const gateway = gatewayFor({ getById: async () => null, listBySession: async () => [] });
    for (const principal of [SCREEN_CAPABILITY_PRINCIPAL, ...Object.values(JUDGE_CAPABILITY_PRINCIPALS)]) {
      expect(() => gateway.describe(principal, documentToolIds.search))
        .toThrowError(expect.objectContaining({ code: 'CAPABILITY_DENIED' }));
    }
  });

  it('fails closed on a cross-Session document lookup and rejects caller-controlled scope', async () => {
    const gateway = gatewayFor({ getById: async () => ({
      document: {
        documentId: 'document-other', sessionId: 'other-session', attachmentId: 'attachment', sourceContentHash: '0'.repeat(64), filename: 'other.txt', detectedMediaType: 'text/plain', extractorId: 'builtin-text', extractorVersion: '1', textHash: '0'.repeat(64), pageCount: null, chunkCount: 0, createdByTurnId: 'turn', createdAt: '2026-09-22T00:00:00.000Z', schemaVersion: 1 as const,
      }, chunks: [],
    }), listBySession: async () => [] });
    await expect(gateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, { query: 'secret', documentId: 'document-other' }))
      .rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
    await expect(gateway.invoke(COMMAND_DOC_SEARCH_CAPABILITY_PRINCIPAL, documentToolIds.search, { query: 'secret', sessionId: 'other-session' }))
      .rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' });
  });
});
