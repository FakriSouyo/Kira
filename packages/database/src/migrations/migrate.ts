import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

/** Daftar migrasi berurutan. File SQL dijalankan sekali, dicatat di _migrations. */
const MIGRATIONS = ['./0001_initial.sql'] as const;

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
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });
    tx();
  }
}
