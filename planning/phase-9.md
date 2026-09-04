# Phase 9A — Real Future: Normalized Tables + Real Embedding + Abort (Opsi A)

> Dekomposisi pekerjaan yang bisa dieksekusi. Fondasi Phase 8 milestone bersih (211/211, `0.3.0` release + CI). Phase 9A = `Real Future` — melanjutkan prototype Phase 7 mock → real minimal yang masih jalan offline (fallback mock) sesuai `addendum_v3.0.md §27 Future`.

## 1. Scope terkunci (apa & apa bukan)

**Masuk (real minimal, masih offline-safe):**
- Normalized tables **real migration** `0002_normalized.sql` (`financials_normalized`, `daily_normalized`) + Drizzle `schema.ts` + `FinharnessDatabase` helper `normalized` (read/write).
- Real embedding path: `packages/shared/src/vector.ts` `embed(text)` — bila `LLM_API_KEY` + `LLM_BASE_URL` tersedia → panggil `LLMClient.generateText` mockable (di-test via `MockLLMClient.generateText`); selain itu fallback `mockEmbedding` (Phase 7). Wrapper `getEmbedding(text, opts?)`.
- Abort/cancellation real: `judgeWorkflow` tool wrapper `tool()` sudah pakai `AbortController`; Phase 9A tambah `signal` plumbing + `workflow.ts` `Workflow.run(ctx, { signal? })` agar `/judge` bisa dibatalkan via `Ctrl+C` → `signal.aborted` check di batas fase (bukan fake).
- Docs: `progress/phase-9/design.md` catat migrasi + embedding fallback + abort.

**Keluar (deferred Phase 9++):**
- pgvector ekstensi `VECTOR(1536)` real (butuh Postgres/pgvector) — tetap mock di Phase 9A; cukup `REAL` array di SQLite normalized vision.
- Tauri GUI penuh — tetap Phase 8 web preview (`3280`) saja.
- npm publish token / Docker — tetap Phase 8 CI.

## 2. Kontrak data (migrasi baru 0002 — pertama sejak Phase 0)

- DB: `executions`/`evidence`/`agent_messages`/`claims`/`judgments` tetap; tambah `financials_normalized` (ticker+year UNIQUE) & `daily_normalized` (ticker+date UNIQUE) — indeks SQLite biasa, bukan `VECTOR`.
- Migrasi idempotent (`IF NOT EXISTS`), `Drizzle` `schema.ts` satu-satunya yang tahu snake↔camel.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `packages/database/src/schema.ts` | +2 table `financialsNormalized`/`dailyNormalized` | tabel 0→1 tetap |
| `packages/database/src/migrations/0002_normalized.sql` | Baru (DDL vision Phase 7 jadi real) | `0001_initial.sql` |
| `packages/database/src/normalized.ts` | Baru helper read/write | `search.ts` tetap |
| `packages/shared/src/vector.ts` | +`getEmbedding` fallback | `mockEmbedding`/`cosineSimilarity` tetap |
| `apps/cli/src/workflows/workflow.ts` | +`signal?` abort check | step logic tetap |
| `apps/cli/src/workflows/judgeWorkflow.ts` | +`opts.signal?` plumbing ke `tool()` | flow tetap |
| `planning/phase-9.md`, `progress/phase-9/*` | docs | `addendum_v3.0.md` locked |

## 4. Keputusan sebelum coding

- Migration `0002` idempotent, `IF NOT EXISTS`, dijalankan `openDb` → `runMigrations` (sudah ada `0001`). `FinharnessDatabase` expose `normalized`.
- `getEmbedding(text, {llm?})`: bila `llm` provided & `!mock` → `await llm.generateText({prompt: \`embed: ${text}\`})` lalu hash ke vec (stub real); fallback `mockEmbedding` deterministik.
- Abort: `Workflow.run(..., {signal})` check `signal.aborted` sebelum tiap step → throw `UserFriendlyError('ABORTED')`; `judgeWorkflow` `tool()` terima `signal` dan `fetchImpl` sudah support `AbortSignal` (SectorsClient).

## 5. Tasklist (TDD, `pnpm check` tiap commit)

Lihat `progress/phase-9/tasklist.md` — 3 task:

1. Normalized migration + helper — **pending**
2. `getEmbedding` real fallback + abort plumbing — **pending**
3. Smoke + docs — **pending**

## 6. Verifikasi

- `pnpm check` hijau (211→215+).
- `pnpm typecheck` + `vitest` E2E tetap hijau offline.
- Migration 0002 ter-apply idempotent (openDb kedua tidak error).

## 7. Risiko

- Migrasi baru jangan pecah `0001` → `IF NOT EXISTS` + test idempotent.
- Embedding real butuh key → fallback mock menjaga offline test hijau.
