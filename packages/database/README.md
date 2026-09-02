# @harness/database

Implementasi SQLite — satu-satunya paket yang menyentuh Drizzle/better-sqlite3.

| Modul | Isi |
|---|---|
| `client.ts` | `openDb({ homeDir?, verbose? })` → `FinharnessDatabase { raw, evidence, conversation, executions, claims, judgments }`; WAL mode, foreign_keys ON, migrasi otomatis saat buka |
| `migrations/migrate.ts` | `runMigrations` — DDL idempoten (executions, evidence, agent_messages, claims, judgments) |
| `schema.ts` | Definisi Drizzle + satu-satunya pemetaan snake_case (DB) ↔ camelCase (TS) |
| `*StoreSqlite.ts` | Implementasi semua store interface dari `@harness/evidence`, `@harness/conversation`, `@harness/execution` |

Catatan:
- DB dibuat otomatis di `<homeDir>/finharness.db` (default `~/.finharness/`; bisa diarahkan `--home`/`FINHARNESS_HOME`).
- Kontrak integritas (uji di `test/stores.test.ts`): dedup content-hash, urutan message per run, `UNIQUE(run_id, message_id)`, `UNIQUE(run_id)` judgment, FK evidence → executions (cascade), CHECK constraint agent/message_type.
