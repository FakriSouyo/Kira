# @harness/database

Implementasi SQLite — satu-satunya paket yang menyentuh Drizzle/better-sqlite3.

| Modul | Isi |
|---|---|
| `client.ts` | `openDb({ homeDir?, verbose? })` → seluruh adapter SQLite; WAL mode, foreign_keys ON, migrasi otomatis saat buka |
| `migrations/migrate.ts` | `runMigrations` — DDL berurutan dan idempoten, termasuk migrasi lifecycle canonical |
| `schema.ts` | Definisi Drizzle + satu-satunya pemetaan snake_case (DB) ↔ camelCase (TS) |
| `researchSessionStoreSqlite.ts` | Persistence boundary canonical untuk Session, Turn, dan Execution attempt |
| `workingContextStoreSqlite.ts` | Penyimpanan versioned `SessionWorkingContext` (PR D) dengan commit compare-and-set |
| `conversationJournalSqlite.ts` | Audit/replay append-only; menyimpan event berkorelasi tanpa membuat atau memiliki Session |
| `*StoreSqlite.ts` | Implementasi store interface lain dari paket kontrak masing-masing |

Catatan:
- DB dibuat otomatis di `<homeDir>/finharness.db` (default `~/.finharness/`; bisa diarahkan `--home`/`FINHARNESS_HOME`).
- `research_turns.run_id` dipertahankan nullable selama transisi; ownership baru
  berada pada `executions.turn_id`. Baris lama di-backfill tanpa mengubah ID atau
  artifact run yang sudah tersimpan.
- Request live membuat Session/Turn melalui `ResearchSessionStore`. Journal
  menyimpan envelope `sessionId`/sequence/timestamp dan payload versioned dengan
  korelasi Turn/Execution; payload lama tetap dibaca tanpa migrasi.
- Kontrak integritas (uji di `test/stores.test.ts`): dedup content-hash, urutan message per run, `UNIQUE(run_id, message_id)`, `UNIQUE(run_id)` judgment, FK evidence → executions (cascade), CHECK constraint agent/message_type.
- `session_context_versions` (migrasi `0008`, PR D): satu baris per versi working
  context yang di-commit, `PRIMARY KEY(session_id, version)`, payload JSON
  terstruktur, `source_sequence` + `updated_by_turn_id` untuk audit. Versi lama
  tetap terbaca; `commit` menolak penulis stale lewat compare-and-set di dalam
  satu transaksi (dan primary key menolak versi duplikat saat balapan). Tidak ada
  pointer "current version" terpisah — `max(version)` yang terindeks adalah
  kebenarannya, sehingga tidak ada state turunan yang bisa drift.
- `sourceSequence` working context memakai sequence kanonik `turn.started` milik
  Turn yang dipublish, bukan journal tail saat settlement; ini mencegah Turn lama
  yang selesai belakangan terlihat lebih baru. Journal tetap audit/urutan, bukan
  store context (event `session.context.updated` hanya membawa referensi versi).
