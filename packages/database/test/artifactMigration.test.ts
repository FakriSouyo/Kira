import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

const PRIOR_MIGRATIONS = [
  './0001_initial.sql',
  './0002_normalized.sql',
  './0003_run_evidence.sql',
  './0004_evidence_hash_scoped.sql',
  './0005_research_sessions.sql',
  './0006_conversation_journal.sql',
  './0007_canonical_lifecycle.sql',
  './0008_session_working_context.sql',
] as const;

describe('PR F artifact migration', () => {
  let migrated: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    migrated?.raw.close();
    migrated = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the artifact table forward-only while preserving prior lifecycle rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-artifact-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
    for (const name of PRIOR_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${name.slice(2)}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    legacy.prepare('INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('session_prior_f', 'Prior', 'openai', 'mock', 'usual', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z');
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    migrated = openDb({ homeDir: dir });
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'").get()).toEqual({ name: 'artifacts' });
    expect(migrated.raw.prepare('SELECT id FROM research_sessions WHERE id = ?').get('session_prior_f')).toEqual({ id: 'session_prior_f' });
    expect(migrated.raw.prepare('SELECT name FROM _migrations WHERE name = ?').get('./0009_artifacts.sql')).toEqual({ name: './0009_artifacts.sql' });
  }, 15_000);
});
