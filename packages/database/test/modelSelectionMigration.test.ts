import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

const PRE_Q2_MIGRATIONS = [
  '0001_initial.sql', '0002_normalized.sql', '0003_run_evidence.sql', '0004_evidence_hash_scoped.sql',
  '0005_research_sessions.sql', '0006_conversation_journal.sql', '0007_canonical_lifecycle.sql',
  '0008_session_working_context.sql', '0009_artifacts.sql', '0010_context_snapshots.sql',
  '0011_turn_model_calls.sql', '0012_financial_snapshots.sql', '0013_durable_resumability.sql',
];

describe('Q2 model selection migration', () => {
  let db: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    if (db?.raw.open) db.raw.close();
    db = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('backfills legacy session intent and adds nullable actual runtime columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-q2-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const filename of PRE_Q2_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${filename}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(`./${filename}`);
    }
    legacy.prepare(`INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-q2-session', 'Legacy Q2', 'openrouter', 'qwen/qwen3', 'usual', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
    legacy.close();

    db = openDb({ homeDir: dir });

    expect(await db.sessions.getCurrentModelSelection('legacy-q2-session')).toEqual({
      sessionId: 'legacy-q2-session', version: 1, providerId: 'openrouter', modelId: 'qwen/qwen3', source: 'legacy', selectedAt: '2026-09-20T00:00:00.000Z',
    });
    const columns = (db.raw.pragma('table_info(model_calls)') as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['provider_id', 'model_id', 'adapter_id', 'protocol', 'runtime_fingerprint']));
  });
});
