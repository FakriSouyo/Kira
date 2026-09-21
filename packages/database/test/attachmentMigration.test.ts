import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

const PRIOR_MIGRATIONS = [
  './0001_initial.sql', './0002_normalized.sql', './0003_run_evidence.sql', './0004_evidence_hash_scoped.sql',
  './0005_research_sessions.sql', './0006_conversation_journal.sql', './0007_canonical_lifecycle.sql',
  './0008_session_working_context.sql', './0009_artifacts.sql', './0010_context_snapshots.sql',
  './0011_turn_model_calls.sql', './0012_financial_snapshots.sql', './0013_durable_resumability.sql',
  './0014_durable_model_selection.sql',
] as const;

describe('S1 attachment migration', () => {
  let migrated: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    migrated?.raw.close();
    migrated = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('applies 0015 forward-only while preserving prior Session/Turn data and foreign keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-attachment-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
    for (const name of PRIOR_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${name.slice(2)}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    legacy.prepare('INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('session_prior_s1', 'Prior', 'openai', 'mock', 'usual', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z');
    legacy.prepare('INSERT INTO research_turns (id, session_id, input, command, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('turn_prior_s1', 'session_prior_s1', '/help', 'help', 'completed', '2026-09-22T00:00:00.000Z');
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    migrated = openDb({ homeDir: dir });
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'attachments'").get()).toEqual({ name: 'attachments' });
    expect(migrated.raw.prepare('SELECT id FROM research_sessions WHERE id = ?').get('session_prior_s1')).toEqual({ id: 'session_prior_s1' });
    expect(migrated.raw.prepare('SELECT id FROM research_turns WHERE id = ?').get('turn_prior_s1')).toEqual({ id: 'turn_prior_s1' });
    expect(migrated.raw.prepare('SELECT name FROM _migrations WHERE name = ?').get('./0015_attachments.sql')).toEqual({ name: './0015_attachments.sql' });

    await expect(migrated.attachments.save({
      sessionId: 'session_prior_s1', turnId: 'turn_prior_s1', filename: 'prior.txt', content: new TextEncoder().encode('prior'),
    })).resolves.toMatchObject({ sessionId: 'session_prior_s1', turnId: 'turn_prior_s1' });
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
