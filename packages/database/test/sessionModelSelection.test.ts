import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-model-selection-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  if (db.raw.open) db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('durable SessionModelSelection', () => {
  it('creates an initial selection and appends user selections monotonically', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-selection-a', title: 'Selection A', provider: 'openai', model: 'gpt-a', reasoningMode: 'usual',
    });

    expect(await db.sessions.getCurrentModelSelection(session.id)).toMatchObject({
      sessionId: session.id, version: 1, providerId: 'openai', modelId: 'gpt-a', source: 'initial',
    });

    const selected = await db.sessions.selectModel({
      sessionId: session.id, providerId: 'openrouter', modelId: 'qwen/qwen3', source: 'user',
    });
    expect(selected).toMatchObject({
      sessionId: session.id, version: 2, providerId: 'openrouter', modelId: 'qwen/qwen3', source: 'user',
    });
    expect(await db.sessions.listModelSelections(session.id)).toHaveLength(2);
  });

  it('isolates selections between sessions and survives a newly opened database instance', async () => {
    const first = await db.sessions.createSession({
      sessionId: 'session-selection-first', title: 'First', provider: 'openai', model: 'gpt-a', reasoningMode: 'usual',
    });
    const second = await db.sessions.createSession({
      sessionId: 'session-selection-second', title: 'Second', provider: 'anthropic', model: 'claude-a', reasoningMode: 'usual',
    });
    await db.sessions.selectModel({ sessionId: first.id, providerId: 'openrouter', modelId: 'qwen/qwen3', source: 'user' });

    expect((await db.sessions.getCurrentModelSelection(second.id))?.providerId).toBe('anthropic');
    db.raw.close();
    db = openDb({ homeDir: dir });

    expect(await db.sessions.getCurrentModelSelection(first.id)).toMatchObject({
      sessionId: first.id, version: 2, providerId: 'openrouter', modelId: 'qwen/qwen3', source: 'user',
    });
    expect(await db.sessions.listModelSelections(second.id)).toEqual([
      expect.objectContaining({ sessionId: second.id, version: 1, providerId: 'anthropic', modelId: 'claude-a', source: 'initial' }),
    ]);
  });

  it('backfills one legacy selection for sessions created by the previous schema', async () => {
    const row = db.raw.prepare('SELECT COUNT(*) AS count FROM session_model_selections').get() as { count: number };
    expect(row.count).toBe(0);
    db.raw.prepare(`
      INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('legacy-session', 'Legacy', 'openai', 'gpt-legacy', 'usual', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
    db.raw.prepare(`
      INSERT INTO session_model_selections (session_id, version, provider_id, model_id, source, selected_at)
      SELECT id, 1, provider, model, 'legacy', created_at FROM research_sessions WHERE id = ?
    `).run('legacy-session');
    expect(await db.sessions.getCurrentModelSelection('legacy-session')).toMatchObject({
      sessionId: 'legacy-session', version: 1, providerId: 'openai', modelId: 'gpt-legacy', source: 'legacy',
    });
  });

  it('keeps concurrent selection writes monotonic and preserves every winning row', async () => {
    const second = openDb({ homeDir: dir });
    try {
      const session = await db.sessions.createSession({
        sessionId: 'session-selection-concurrent', title: 'Concurrent', provider: 'openai', model: 'gpt-a', reasoningMode: 'usual',
      });

      const results = await Promise.all([
        db.sessions.selectModel({ sessionId: session.id, providerId: 'openai', modelId: 'gpt-b', source: 'user' }),
        second.sessions.selectModel({ sessionId: session.id, providerId: 'openai', modelId: 'gpt-c', source: 'user' }),
      ]);
      const history = await db.sessions.listModelSelections(session.id);

      expect(results).toHaveLength(2);
      expect(history.map(item => item.version)).toEqual([1, 2, 3]);
      expect(new Set(history.map(item => item.version)).size).toBe(history.length);
      expect(history.slice(1).map(item => item.modelId).sort()).toEqual(['gpt-b', 'gpt-c']);
      expect((await db.sessions.getCurrentModelSelection(session.id))?.modelId).toBe(history.at(-1)?.modelId);
    } finally {
      second.raw.close();
    }
  });
});
