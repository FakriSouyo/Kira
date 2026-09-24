import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { AgentEvent } from '../src/repl/events';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';

describe('CLI conversation response workflow integration', () => {
  let db: FinharnessDatabase;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kira-conversation-workflow-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const config = () => loadConfig({ homeDir: dir, mockSectors: true, mockLlm: true });

  it('keeps streaming event order and settles one conversation Turn without an Execution', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(db, config(), { events: event => events.push(event), write: () => {} });
    vi.spyOn(session.context.mainAgent, 'stream').mockImplementation(async function* () {
      yield 'one';
      yield ' two';
    });

    await session.handleNaturalLanguage('hello');

    expect(events.filter(event => ['conversation.user', 'conversation.start', 'conversation.delta', 'conversation.complete', 'conversation.failed'].includes(event.type))
      .map(event => event.type)).toEqual([
      'conversation.user', 'conversation.start', 'conversation.delta', 'conversation.delta', 'conversation.complete',
    ]);
    expect(events.filter((event): event is Extract<AgentEvent, { type: 'conversation.delta' }> => event.type === 'conversation.delta')
      .map(event => event.content)).toEqual(['one', ' two']);
    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    expect(artifacts.turns.filter(turn => turn.command === 'conversation')).toHaveLength(1);
    expect(artifacts.turns.find(turn => turn.command === 'conversation')?.status).toBe('completed');
    expect(artifacts.executions).toHaveLength(0);
    await session.close();
  });

  it('keeps non-streaming answer output unchanged', async () => {
    const writes: string[] = [];
    const session = await createHarnessSession(db, config(), { write: text => writes.push(text) });
    vi.spyOn(session.context.mainAgent, 'respond').mockResolvedValue('Exact final answer');

    await session.handleNaturalLanguage('hello');

    expect(writes).toEqual(['Exact final answer\n\n']);
    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    expect(artifacts.turns.filter(turn => turn.command === 'conversation')).toHaveLength(1);
    expect(artifacts.executions).toHaveLength(0);
    await session.close();
  });

  it('maps cancellation to a stopped Turn and keeps the post-yield abort fence', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(db, config(), { events: event => events.push(event), write: () => {} });
    const abort = new AbortController();
    vi.spyOn(session.context.mainAgent, 'stream').mockImplementation(async function* () {
      yield 'partial';
      abort.abort();
      yield 'discarded';
    });

    await expect(session.handleNaturalLanguage('hello', { signal: abort.signal })).rejects.toMatchObject({ code: 'ABORTED' });

    expect(events.filter((event): event is Extract<AgentEvent, { type: 'conversation.delta' }> => event.type === 'conversation.delta')
      .map(event => event.content)).toEqual(['partial']);
    expect(events.find(event => event.type === 'conversation.failed')).toMatchObject({ error: { code: 'ABORTED', message: 'Response cancelled' } });
    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    expect(artifacts.turns.filter(turn => turn.command === 'conversation')).toHaveLength(1);
    expect(artifacts.turns.find(turn => turn.command === 'conversation')?.status).toBe('stopped');
    expect(artifacts.executions).toHaveLength(0);
    await session.close();
  });

  it('emits a failure event and settles a failed conversation Turn', async () => {
    const events: AgentEvent[] = [];
    const session = await createHarnessSession(db, config(), { events: event => events.push(event), write: () => {} });
    vi.spyOn(session.context.mainAgent, 'stream').mockImplementation(async function* () {
      yield 'partial';
      throw new Error('model unavailable');
    });

    await expect(session.handleNaturalLanguage('hello')).rejects.toThrow('model unavailable');

    expect(events.find(event => event.type === 'conversation.failed')).toMatchObject({ error: { code: 'CONVERSATION_ERROR' } });
    const artifacts = await db.sessions.getSessionArtifacts(session.conversation.id);
    expect(artifacts.turns.filter(turn => turn.command === 'conversation')).toHaveLength(1);
    expect(artifacts.turns.find(turn => turn.command === 'conversation')?.status).toBe('failed');
    expect(artifacts.executions).toHaveLength(0);
    await session.close();
  });
});
