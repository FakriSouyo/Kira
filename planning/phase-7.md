# Phase 7 — Future: Vector Search & Normalized Vision (Prototype)

> Dekomposisi pekerjaan yang bisa dieksekusi. Fondasi Phase 6 milestone bersih (203/203, `0.2.0` RC → release, evaluasi agregat `eval.md`). Phase 7 = `Future` sesuai `addendum_v3.0.md §27 Future`: vector search & semantic + normalized tables vision — **prototipe in-memory** (tanpa pgvector/Tauri, menjaga fondasi `AGENTS.md` minimal abstraction).

## 1. Scope terkunci (apa & apa bukan)

**Masuk (prototipe, bukan produksi):**
- Vector helper in-memory: `packages/shared/src/vector.ts` — `cosineSimilarity`, `mockEmbedding(text)` deterministik (hash → vec 8-dim), `searchByVector` stub.
- Evidence semantic search (keyword fallback): `packages/database/src/search.ts` `searchEvidence(runId|tik, query)` — scoring `keywordOverlap` atas `data` JSON evidence (placeholder untuk `pgvector` cosine); mengembalikan `Evidence[]` ranking.
- CLI `/search <query>` — cari evidence run terakhir atau `runId` tertentu (`/search roe --run <id>`), tampilkan hasil via `renderSearchResult`.
- Normalized tables vision (docs only): `progress/phase-7/design.md` § Future schema `financials_normalized`, `daily_normalized` — tidak migrasi DB di Phase 7 (prototype read-only).

**Keluar (deferred Future penuh):**
- pgvector / `pg` ekstensi, Tauri GUI penuh, LangGraph conditional lanjutan — tetap Future (tidak dikerjakan di Phase 7 prototype).
- Embedding model real (OpenAI `text-embedding-3-small`) — butuh API key; Phase 7 pakai mock deterministik.

## 2. Kontrak data (reuse DB)

- DB reuse: `evidence` (`data` JSON), `executions` — tidak ada migrasi baru Phase 7 (vision di docs).
- Canonical JSON tidak berubah.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `packages/shared` | `vector.ts` (baru) + `index.ts` re-export | `rubric.ts`, `metrics.ts` |
| `packages/database` | `search.ts` (baru) `searchEvidence` | `schema.ts`, `executionStoreSqlite.ts` |
| `apps/cli/src/commands` | `search.ts` (baru, `/search`), `index.ts` wiring | `workflows` |
| `apps/cli/src/repl` | `renderer.ts` `renderSearchResult` | `loop.ts`, `web.ts` |
| `planning/`, `progress/phase-7/` | docs | `addendum_v3.0.md` locked |

## 4. Keputusan sebelum coding

- `mockEmbedding(text)`: hash FNV → 8-dim normalized `[-1,1]` deterministik, tanpa network.
- `searchEvidence(runId?, query)`: bila `runId` diberikan → filter `evidence.runId`; selain itu → run terakhir (`listRuns(1)`). Score = `keywordOverlap` (jumlah token query yang muncul di `JSON.stringify(data)` lowercased) + `cosineSimilarity` mock (tie-break).
- `/search <query> [--run <id>] [--limit N]` default limit 5, max 20.
- Normalized vision: tulis DDL vision di `progress/phase-7/design.md` (tidak dieksekusi).

## 5. Tasklist (TDD, `pnpm check` tiap commit)

Lihat `progress/phase-7/tasklist.md` — 3 task:

1. Vector helper + searchEvidence — **pending**
2. `/search` command + renderer — **pending**
3. Smoke + docs Future — **pending**

## 6. Verifikasi

- `pnpm check` hijau (203→210+).
- `pnpm finharness --mock-sectors --mock-llm` → `/judge BBCA` → `/search ROE` menampilkan evidence dengan `content_hash`.
- E2E tetap hijau.

## 7. Risiko

- Mock embedding bukan vektor real — eksplisit di docs sebagai placeholder pgvector (tidak menyesatkan). API real ditunda Future dengan key.
