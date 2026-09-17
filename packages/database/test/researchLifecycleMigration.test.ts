import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

const migrationNames = [
  './0001_initial.sql',
  './0002_normalized.sql',
  './0003_run_evidence.sql',
  './0004_evidence_hash_scoped.sql',
  './0005_research_sessions.sql',
  './0006_conversation_journal.sql',
];

describe('canonical lifecycle migration', () => {
  let migrated: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    migrated?.raw.close();
    migrated = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('preserves an existing turn and moves its run linkage onto the execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-lifecycle-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE research_sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        reasoning_mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE executions (
        id TEXT PRIMARY KEY, ticker TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL,
        execution_time REAL, error TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE research_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
        input TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX idx_research_turns_session ON research_turns(session_id, started_at);
      CREATE TABLE evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE run_evidence (
        run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
        PRIMARY KEY (run_id, evidence_id)
      );
      CREATE TABLE agent_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE claims (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE judgments (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE workflow_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      CREATE TABLE model_calls (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      );
      INSERT INTO research_sessions VALUES ('session-old', 'Legacy', 'openai', 'gpt-test', 'usual', '2026-09-01', '2026-09-01');
      INSERT INTO executions VALUES ('run-old', 'BBRI', 'judge', 'completed', 4.2, NULL, '2026-09-01', '2026-09-01');
      INSERT INTO executions VALUES ('run-unlinked', 'BMRI', 'judge', 'failed', NULL, 'legacy', '2026-09-01', '2026-09-01');
      INSERT INTO research_turns VALUES ('turn-old', 'session-old', 'run-old', '/judge BBRI', 'judge', 'completed', '2026-09-01', '2026-09-01');
      INSERT INTO evidence VALUES ('evidence-old', 'run-old', '{}');
      INSERT INTO run_evidence VALUES ('run-old', 'evidence-old');
      INSERT INTO agent_messages VALUES ('message-old', 'run-old', '{}');
      INSERT INTO claims VALUES ('claim-old', 'run-old', '{}');
      INSERT INTO judgments VALUES ('judgment-old', 'run-old', '{}');
      INSERT INTO workflow_steps VALUES ('step-old', 'run-old', '{}');
      INSERT INTO model_calls VALUES ('call-old', 'run-old', 'step-old', '{}');
    `);
    const insertMigration = legacy.prepare('INSERT INTO _migrations (name) VALUES (?)');
    for (const name of migrationNames) insertMigration.run(name);
    legacy.close();

    migrated = openDb({ homeDir: dir });

    const turnColumns = migrated.raw.prepare('PRAGMA table_info(research_turns)').all() as Array<{ name: string; notnull: number }>;
    expect(turnColumns.find((column) => column.name === 'run_id')?.notnull).toBe(0);
    const uniqueTurnIndexes = (migrated.raw.prepare('PRAGMA index_list(research_turns)').all() as Array<{ unique: number; origin: string }>)
      .filter((index) => index.unique === 1 && index.origin !== 'pk');
    expect(uniqueTurnIndexes).toEqual([]);
    expect(migrated.raw.prepare('SELECT id, session_id, run_id FROM research_turns').get()).toEqual({
      id: 'turn-old', session_id: 'session-old', run_id: 'run-old',
    });
    expect(migrated.raw.prepare('SELECT session_id, turn_id, attempt FROM executions WHERE id = ?').get('run-old')).toEqual({
      session_id: 'session-old', turn_id: 'turn-old', attempt: 1,
    });
    expect(migrated.raw.prepare('SELECT session_id, turn_id, attempt FROM executions WHERE id = ?').get('run-unlinked')).toEqual({
      session_id: null, turn_id: null, attempt: null,
    });
    expect(migrated.raw.prepare('SELECT id, run_id FROM evidence').get()).toEqual({
      id: 'evidence-old', run_id: 'run-old',
    });
    expect(migrated.raw.prepare('SELECT run_id, evidence_id FROM run_evidence').get()).toEqual({
      run_id: 'run-old', evidence_id: 'evidence-old',
    });
    expect(migrated.raw.prepare('SELECT id, run_id FROM agent_messages').get()).toEqual({
      id: 'message-old', run_id: 'run-old',
    });
    expect(migrated.raw.prepare('SELECT id, run_id FROM claims').get()).toEqual({
      id: 'claim-old', run_id: 'run-old',
    });
    expect(migrated.raw.prepare('SELECT id, run_id FROM judgments').get()).toEqual({
      id: 'judgment-old', run_id: 'run-old',
    });
    expect(migrated.raw.prepare('SELECT id, run_id FROM workflow_steps').get()).toEqual({
      id: 'step-old', run_id: 'run-old',
    });
    expect(migrated.raw.prepare('SELECT id, run_id, step_id FROM model_calls').get()).toEqual({
      id: 'call-old', run_id: 'run-old', step_id: 'step-old',
    });
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const executionIndexes = (migrated.raw.prepare('PRAGMA index_list(executions)').all() as Array<{ name: string }>)
      .map((index) => index.name);
    expect(executionIndexes).toEqual(expect.arrayContaining([
      'idx_executions_ticker',
      'idx_executions_status',
      'idx_executions_created',
      'idx_executions_session',
      'idx_executions_turn',
      'executions_turn_attempt_uniq',
    ]));
  });
});
