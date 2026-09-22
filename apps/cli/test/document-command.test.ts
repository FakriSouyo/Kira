import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityGateway } from '@harness/capability';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { createHarnessSession } from '../src/repl/session';
import { loadConfig } from '../src/config';
import { renderDocumentIndexResult, renderDocumentSearchResult } from '../src/repl/renderer';
import { buildDocumentBundle, searchDocumentChunks } from '@harness/document';

describe('document commands', () => {
  let db: FinharnessDatabase | undefined;
  let homeDir: string | undefined;
  let sourceDir: string | undefined;

  afterEach(async () => {
    db?.raw.close();
    db = undefined;
    if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    if (sourceDir) rmSync(sourceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createSession() {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-document-command-'));
    sourceDir = mkdtempSync(join(tmpdir(), 'finharness-document-source-'));
    db = openDb({ homeDir });
    const writes: string[] = [];
    const session = await createHarnessSession(
      db,
      loadConfig({ homeDir, mockSectors: true, mockLlm: true }),
      { write: text => writes.push(text) },
    );
    return { session, writes };
  }

  async function attachAndIndex(session: Awaited<ReturnType<typeof createHarnessSession>>, filename: string, text: string) {
    const path = join(sourceDir!, filename);
    writeFileSync(path, text);
    await session.commands.get('attach')!([path], { input: `/attach "${path}"` });
    const attachment = (await db!.attachments.listBySession(session.conversation.id)).at(-1)!;
    await session.commands.get('doc-index')!([attachment.attachmentId], { input: `/doc-index ${attachment.attachmentId}` });
    const bundle = await db!.documents.getByAttachment({
      attachmentId: attachment.attachmentId,
      extractorId: 'builtin-text',
      extractorVersion: 'pipeline-v1',
    });
    return { attachment, bundle: bundle! };
  }

  it('indexes through attachment.read, searches through document.search, and performs no Execution/model/financial work', async () => {
    const { session, writes } = await createSession();
    const financialSpies = ['getCompanyReport', 'getQuarterlyFinancials', 'screen', 'getDailyTransaction', 'getForeignFlow', 'getNews', 'getFilings', 'getSentiment']
      .map(method => vi.spyOn(session.context.financialData, method as keyof typeof session.context.financialData));
    const invoke = vi.spyOn(CapabilityGateway.prototype, 'invoke');
    const { bundle } = await attachAndIndex(session, 'research.txt', 'Revenue grew strongly.\n\nDebt remains high.');

    expect(bundle.document.chunkCount).toBe(2);
    expect(writes.join('')).toContain(bundle.document.documentId);
    writes.length = 0;
    await session.commands.get('doc-search')!(['revenue'], { input: '/doc-search revenue' });

    expect(writes.join('')).toContain('research.txt');
    expect(writes.join('')).toContain(bundle.chunks[0]!.chunkId);
    expect(invoke.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [{ id: 'command.doc-index' }, 'attachment.read'],
      [{ id: 'command.doc-search' }, 'document.search'],
    ]);
    expect(financialSpies.every(spy => spy.mock.calls.length === 0)).toBe(true);
    const artifacts = await db!.sessions.getSessionArtifacts(session.conversation.id);
    expect(artifacts.executions).toEqual([]);
    expect(artifacts.modelCalls).toEqual([]);
    expect(artifacts.turns.filter(turn => turn.command === 'doc-index')).toHaveLength(1);
    expect(artifacts.turns.filter(turn => turn.command === 'doc-search')).toHaveLength(1);
    await session.close();
  });

  it('is idempotent when the same attachment is indexed twice and rejects command argument drift', async () => {
    const { session } = await createSession();
    const first = await attachAndIndex(session, 'repeat.md', '# Thesis\n\nRevenue grew.');
    await session.commands.get('doc-index')!([first.attachment.attachmentId], { input: `/doc-index ${first.attachment.attachmentId}` });
    expect(await db!.documents.listBySession(session.conversation.id)).toHaveLength(1);
    await expect(session.commands.get('doc-index')!([], { input: '/doc-index' })).rejects.toMatchObject({ code: 'INVALID_ARG' });
    await expect(session.commands.get('doc-search')!(['query', '--limit', '0'], { input: '/doc-search query --limit 0' })).rejects.toMatchObject({ code: 'INVALID_ARG' });
    await session.close();
  });

  it('rebinds document search from Document A to Document B after openConversation', async () => {
    const { session, writes } = await createSession();
    const first = await attachAndIndex(session, 'session-a.txt', 'private alpha material');
    const second = await db!.sessions.createSession({ sessionId: 'document-command-session-b', title: 'B', provider: 'mock', model: 'mock', reasoningMode: 'usual' });
    const secondTurn = await db!.sessions.createTurn({
      sessionId: second.id,
      turnId: 'document-command-session-b-index-turn',
      input: '/doc-index attachment-b',
      command: 'doc-index',
    });
    const secondContent = new TextEncoder().encode('private beta material');
    const secondAttachment = await db!.attachments.save({
      sessionId: second.id,
      turnId: secondTurn.id,
      filename: 'session-b.txt',
      content: secondContent,
    });
    const other = await buildDocumentBundle({
      attachment: secondAttachment,
      content: secondContent,
      createdByTurnId: secondTurn.id,
    });
    await db!.documents.save(other);

    writes.length = 0;
    await session.commands.get('doc-search')!(['alpha'], { input: '/doc-search alpha' });
    expect(writes.join('')).toContain(first.bundle.chunks[0]!.chunkId);
    writes.length = 0;
    await session.commands.get('doc-search')!(['beta'], { input: '/doc-search beta' });
    expect(writes.join('')).toContain('No document chunks matched');
    expect(writes.join('')).not.toContain(other.document.documentId);
    expect(writes.join('')).not.toContain(other.chunks[0]!.chunkId);

    await session.openConversation(second.id);
    writes.length = 0;
    await session.commands.get('doc-search')!(['beta'], { input: '/doc-search beta' });
    expect(writes.join('')).toContain(other.chunks[0]!.chunkId);
    expect(writes.join('')).not.toContain(first.bundle.chunks[0]!.chunkId);
    writes.length = 0;
    await session.commands.get('doc-search')!(['alpha'], { input: '/doc-search alpha' });
    expect(writes.join('')).toContain('No document chunks matched');
    expect(writes.join('')).not.toContain(first.bundle.document.documentId);
    expect(writes.join('')).not.toContain(first.bundle.chunks[0]!.chunkId);
    await session.close();
  });

  it('rebinds Document authority after a successful /new', async () => {
    const { session, writes } = await createSession();
    const first = await attachAndIndex(session, 'new-a.txt', 'private alpha material');
    const firstSessionId = session.conversation.id;
    await session.commands.get('new')!([], { input: '/new' });
    expect(session.conversation.id).not.toBe(firstSessionId);
    writes.length = 0;
    await session.commands.get('doc-search')!(['alpha'], { input: '/doc-search alpha' });
    expect(writes.join('')).toContain('No document chunks matched');
    const second = await attachAndIndex(session, 'new-b.txt', 'private beta material');
    writes.length = 0;
    await session.commands.get('doc-search')!(['beta'], { input: '/doc-search beta' });
    expect(writes.join('')).toContain(second.bundle.chunks[0]!.chunkId);
    expect(writes.join('')).not.toContain(first.bundle.chunks[0]!.chunkId);
    await session.close();
  });

  it('renders bounded search previews and page counts only for PDFs', async () => {
    const { session } = await createSession();
    const first = await attachAndIndex(session, 'long.txt', `alpha ${'detail '.repeat(120)}endmarker`);
    const hits = searchDocumentChunks(first.bundle.document, first.bundle.chunks, { query: 'alpha' });
    const rendered = renderDocumentSearchResult('alpha', hits);
    expect(rendered).toContain('alpha');
    expect(rendered).not.toContain('endmarker');
    expect(rendered.length).toBeLessThan(700);
    expect(renderDocumentIndexResult(first.bundle.document)).not.toContain('Pages:');
    expect(renderDocumentIndexResult({ ...first.bundle.document, pageCount: 2 })).toContain('Pages: 2');
    await session.close();
  });

  it('orders equal-score hits across Documents by documentId regardless of insertion order', async () => {
    const { session } = await createSession();
    const first = await attachAndIndex(session, 'first.txt', 'capital expenditure');
    const second = await attachAndIndex(session, 'second.txt', 'capital expenditure');
    const result = await session.context.capabilityGateway.invoke(
      { id: 'command.doc-search' }, 'document.search', { query: 'capital expenditure' },
    );
    expect(result.value.map(hit => hit.score)).toEqual([122, 122]);
    expect(result.value.map(hit => hit.citation.documentId)).toEqual([
      first.bundle.document.documentId, second.bundle.document.documentId,
    ].sort());
    await session.close();
  });

  it('keeps controller and document context on A when openConversation B preparation fails', async () => {
    const { session, writes } = await createSession();
    const first = await attachAndIndex(session, 'failure-a.txt', 'private alpha material');
    const second = await db!.sessions.createSession({ sessionId: 'document-command-session-failure-b', title: 'B', provider: 'mock', model: 'mock', reasoningMode: 'usual' });
    await db!.sessions.selectModel({ sessionId: second.id, providerId: 'unavailable-provider', modelId: 'unavailable-model', source: 'user' });

    await expect(session.openConversation(second.id)).rejects.toMatchObject({ code: 'INVALID_PROVIDER' });
    expect(session.conversation.id).toBe(first.bundle.document.sessionId);
    writes.length = 0;
    await session.commands.get('doc-search')!(['private'], { input: '/doc-search private' });
    expect(writes.join('')).toContain(first.bundle.chunks[0]!.chunkId);
    await session.close();
  });

  it('keeps document authority on A when /new preparation fails', async () => {
    const { session, writes } = await createSession();
    const first = await attachAndIndex(session, 'new-failure-a.txt', 'private alpha material');
    const firstSessionId = session.conversation.id;
    const originalSelection = db!.sessions.getCurrentModelSelection.bind(db!.sessions);
    vi.spyOn(db!.sessions, 'getCurrentModelSelection').mockImplementation(async (sessionId) => {
      if (sessionId !== firstSessionId) {
        return { sessionId, version: 2, providerId: 'unavailable-provider', modelId: 'unavailable-model', source: 'user', selectedAt: new Date().toISOString() };
      }
      return originalSelection(sessionId);
    });

    await expect(session.commands.get('new')!([], { input: '/new' })).rejects.toMatchObject({ code: 'INVALID_PROVIDER' });
    expect(session.conversation.id).toBe(firstSessionId);
    writes.length = 0;
    await session.commands.get('doc-search')!(['private'], { input: '/doc-search private' });
    expect(writes.join('')).toContain(first.bundle.chunks[0]!.chunkId);
    await session.close();
  });
});
