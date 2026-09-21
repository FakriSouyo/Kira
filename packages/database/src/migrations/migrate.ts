import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

/** Daftar migrasi berurutan. File SQL dijalankan sekali, dicatat di _migrations. */
const MIGRATIONS = ['./0001_initial.sql', './0002_normalized.sql', './0003_run_evidence.sql', './0004_evidence_hash_scoped.sql', './0005_research_sessions.sql', './0006_conversation_journal.sql', './0007_canonical_lifecycle.sql', './0008_session_working_context.sql', './0009_artifacts.sql', './0010_context_snapshots.sql', './0011_turn_model_calls.sql', './0012_financial_snapshots.sql', './0013_durable_resumability.sql', './0014_durable_model_selection.sql', './0015_attachments.sql'] as const;

const TURN_MODEL_CALL_COLUMNS = [
  'id', 'run_id', 'step_id', 'context_snapshot_id', 'subagent', 'provider', 'model', 'attempt',
  'input_tokens', 'output_tokens', 'cached_input_tokens', 'total_tokens', 'latency_ms',
  'finish_reason', 'cost', 'currency', 'created_at',
] as const;

/**
 * Very old installations had a payload-only model_calls table even though
 * they were marked through the pre-PR-I lifecycle migrations. Keep those rows
 * auditable while allowing the turn-owned ModelCall shape to be introduced.
 */
function migrateTurnModelCalls(db: Database.Database, sql: string): void {
  const columns = new Set((db.pragma('table_info(model_calls)') as Array<{ name: string }>).map(column => column.name));
  const canCopyLosslessly = TURN_MODEL_CALL_COLUMNS.every(column => columns.has(column));
  if (canCopyLosslessly) {
    db.exec(sql);
    return;
  }

  db.exec(`
    CREATE TABLE model_calls_pr_i (
      id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES executions(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES research_turns(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES workflow_steps(id) ON DELETE CASCADE,
      context_snapshot_id TEXT REFERENCES context_snapshots(snapshot_id) ON DELETE RESTRICT,
      subagent TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      total_tokens INTEGER,
      latency_ms REAL NOT NULL,
      finish_reason TEXT,
      cost REAL,
      currency TEXT,
      created_at TEXT NOT NULL,
      CHECK ((run_id IS NOT NULL AND turn_id IS NULL AND step_id IS NOT NULL)
          OR (run_id IS NULL AND turn_id IS NOT NULL AND step_id IS NULL))
    );

    INSERT INTO model_calls_pr_i (
      id, run_id, turn_id, step_id, context_snapshot_id, subagent, provider, model,
      attempt, input_tokens, output_tokens, cached_input_tokens, total_tokens,
      latency_ms, finish_reason, cost, currency, created_at
    )
    SELECT id, run_id, NULL, step_id, NULL, 'legacy', 'legacy', 'legacy', 1,
      NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, datetime('now')
    FROM model_calls;

    DROP TABLE model_calls;
    ALTER TABLE model_calls_pr_i RENAME TO model_calls;

    CREATE INDEX idx_model_calls_run ON model_calls(run_id, created_at);
    CREATE INDEX idx_model_calls_turn ON model_calls(turn_id, created_at);
    CREATE INDEX model_calls_context_snapshot_idx ON model_calls(context_snapshot_id);
  `);
}

export function runMigrations(db: Database.Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))',
  );

  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );

  for (const name of MIGRATIONS) {
    if (applied.has(name)) continue;

    const sql = readFileSync(new URL(name, import.meta.url), 'utf8');
    const rebuildsReferencedTable = name === './0007_canonical_lifecycle.sql' || name === './0011_turn_model_calls.sql' || name === './0013_durable_resumability.sql';
    if (rebuildsReferencedTable) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        if (name === './0011_turn_model_calls.sql') migrateTurnModelCalls(db, sql);
        else db.exec(sql);
        if (rebuildsReferencedTable) {
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) throw new Error('Durable resumability migration left invalid foreign keys');
        }
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
      });
      tx();
    } finally {
      if (rebuildsReferencedTable) db.pragma('foreign_keys = ON');
    }
  }
}
