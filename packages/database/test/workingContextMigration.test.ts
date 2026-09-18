import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

/** Migrations shipped before PR D; a legacy database is upgraded from this state. */
const LEGACY_MIGRATIONS = [
  './0001_initial.sql',
  './0002_normalized.sql',
  './0003_run_evidence.sql',
  './0004_evidence_hash_scoped.sql',
  './0005_research_sessions.sql',
  './0006_conversation_journal.sql',
  './0007_canonical_lifecycle.sql',
] as const;

describe('working-context migration', () => {
  let migrated: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    migrated?.raw.close();
    migrated = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades a pre-PR-D database additively and keeps existing lifecycle rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-wc-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    for (const name of LEGACY_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${name.slice(2)}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    legacy.prepare("INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run('conversation_legacy', 'Legacy', 'openai', 'gpt-test', 'usual', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    legacy.prepare("INSERT INTO research_turns (id, session_id, run_id, input, command, status, started_at, completed_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)")
      .run('turn_legacy', 'conversation_legacy', '/judge BBCA', 'judge', 'completed', '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:02.000Z');
    legacy.prepare("INSERT INTO executions (id, session_id, turn_id, attempt, ticker, command, status, execution_time, error, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
      .run('run_legacy', 'conversation_legacy', 'turn_legacy', 1, 'BBCA', 'judge', 'completed', 1.5, '2026-09-01T00:00:01.000Z', '2026-09-01T00:00:02.000Z');
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    // openDb applies 0008 only; the table starts empty and every legacy row survives.
    migrated = openDb({ homeDir: dir });
    expect(await migrated.workingContext.current('conversation_legacy')).toBeNull();
    const artifacts = await migrated.sessions.getSessionArtifacts('conversation_legacy');
    expect(artifacts.turns).toHaveLength(1);
    expect(artifacts.executions).toEqual([expect.objectContaining({ id: 'run_legacy', ticker: 'BBCA', status: 'completed' })]);
    expect(migrated.raw.prepare('SELECT name FROM _migrations').all()).toContainEqual({ name: './0008_session_working_context.sql' });

    // The new store is usable on the migrated database.
    const committed = await migrated.workingContext.commit({
      sessionId: 'conversation_legacy', expectedVersion: 0, sourceSequence: 1, updatedByTurnId: 'turn_legacy',
      patch: { activeSubjects: [{ ticker: 'BBCA' }], currentIntent: { command: 'judge' } },
    });
    expect(committed).toMatchObject({ version: 1, updatedByTurnId: 'turn_legacy' });
    expect((await migrated.workingContext.current('conversation_legacy'))?.activeSubjects).toEqual([{ ticker: 'BBCA' }]);
  });

  it('keeps context versions readable after the database is reopened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-wc-restart-'));
    dirs.push(dir);
    migrated = openDb({ homeDir: dir });
    await migrated.sessions.createSession({ sessionId: 'conversation_restart', title: 'Restart', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const turn = await migrated.sessions.createTurn({ sessionId: 'conversation_restart', input: '/judge BBRI', command: 'judge' });
    await migrated.workingContext.commit({
      sessionId: 'conversation_restart', expectedVersion: 0, sourceSequence: 3, updatedByTurnId: turn.id,
      patch: { activeSubjects: [{ ticker: 'BBRI' }], activeVerdictRef: { kind: 'judgment', executionId: 'run_bbri' } },
    });
    migrated.raw.close();
    migrated = undefined;

    // Fresh process: the durable version store answers, with no in-memory state.
    migrated = openDb({ homeDir: dir });
    const restored = await migrated.workingContext.current('conversation_restart');
    expect(restored).toMatchObject({ version: 1, sourceSequence: 3, updatedByTurnId: turn.id });
    expect(restored?.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
    expect(restored?.activeVerdictRef).toEqual({ kind: 'judgment', executionId: 'run_bbri' });
    expect((await migrated.workingContext.history('conversation_restart')).map(version => version.version)).toEqual([1]);
  });
});