import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

/** Daftar migrasi berurutan. File SQL dijalankan sekali, dicatat di _migrations. */
const MIGRATIONS = ['./0001_initial.sql', './0002_normalized.sql', './0003_run_evidence.sql', './0004_evidence_hash_scoped.sql', './0005_research_sessions.sql', './0006_conversation_journal.sql', './0007_canonical_lifecycle.sql', './0008_session_working_context.sql', './0009_artifacts.sql', './0010_context_snapshots.sql'] as const;

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
    const rebuildsReferencedTable = name === './0007_canonical_lifecycle.sql';
    if (rebuildsReferencedTable) db.pragma('foreign_keys = OFF');
    try {
      const tx = db.transaction(() => {
        db.exec(sql);
        if (rebuildsReferencedTable) {
          const violations = db.pragma('foreign_key_check') as unknown[];
          if (violations.length > 0) throw new Error('Canonical lifecycle migration left invalid foreign keys');
        }
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
      });
      tx();
    } finally {
      if (rebuildsReferencedTable) db.pragma('foreign_keys = ON');
    }
  }
}
