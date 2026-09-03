# Phase 3 — Orchestration Upgrade (Conditional Workflow + Where Screener)

> Dekomposisi pekerjaan yang bisa dieksekusi, bukan eksekusi penuh. Fondasi Phase 2 dianggap milestone bersih (177/177, streaming + export + skill-registry + replay fixture). Phase 3 = `Orchestration Upgrade` sesuai `addendum_v3.0.md §27`: evaluasi LangGraph, conditional workflow, dan penutupan deviasi screener.

## 1. Scope terkunci (apa & apa bukan)

**Masuk:**
- Evaluasi LangGraph vs hardcode workflow (keputusan: **tidak adopsi LangGraph** — minimal abstraction, workflow tetap hardcode + builder ringan).
- Abstraksi workflow ringan: `WorkflowBuilder` / `defineWorkflow` (linear DAG + conditional branch) di `apps/cli/src/workflows/workflow.ts` — dipakai `judgeWorkflow` tanpa mengubah kontrak agent pure.
- Conditional debate (addendum §27 "Debate ronde 2"): `judgeWorkflow({ conditional: boolean })` — bila `judgment.stance === 'neutral'` atau `score` 40–60, jalankan satu ronde tambahan Bear → Bull (reuse evidence, tidak re-fetch).
- Penutupan deviasi screener #14b/#18: `SectorsClient.screen` memakai `?where=` SQL-native v2 (`/companies/?where=...`) untuk `profitable`/`growing`; fallback client-side scoring tetap untuk mock/universe kecil.
- Agent-Events tetap pintu JSONL (Phase 2) — workflow baru emit `phase` tambahan untuk conditional ronde.

**Keluar (deferred):**
- GUI Tauri Phase 4, pgvector / normalized tables Future — tidak dikerjakan di Phase 3.
- Worker-thread cancel asli (referensi DSH §24-B.4) — tetap best-effort di batas fase (Phase 3 tidak mengubah cancellation).
- Skill-registry baru — sudah di Phase 2, tidak ditambah di Phase 3.

## 2. Kontrak data (tidak ada migrasi schema DB baru — reuse)

- DB: `executions`, `evidence` (`UNIQUE content_hash`), `agent_messages` (`sequence_order` kini bisa 0–6 bila conditional), `claims`, `judgments` (`breakdown` 5 kategori) — satu-satunya yang tahu `snake↔camel` tetap `packages/database/src/schema.ts`.
- Canonical JSON: `packages/shared/src/canonical.ts` + `prompt.ts` `renderEvidenceBlock` zona [1] byte-identical — Phase 3 tidak mengubah canonical.
- Sectors: `packages/sectors-api/src/client.ts:screen` — tambah `buildWhereClause(criteria)` → `?where=roe>0 AND revenue_growth>0`; encode untuk URL. `MockSectorsApi.screen` tetap pakai `computeMatchScore` lokal (deterministik).
- LLM: `packages/llm/src/client.ts` dua-tier tetap; `WorkflowBuilder` tidak menyentuh LLM langsung — hanya orkestrasi.
- Config: tidak ada field baru; `features.conditional_debate` boolean opsional (default false) — fiturnya opt-in via `--conditional` flag `/judge`.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `apps/cli/src/workflows` | `workflow.ts` (baru) + `judgeWorkflow.ts` (conditional) + `screenWorkflow.ts` (where) | `agent` pure functions |
| `packages/sectors-api` | `client.ts` `buildWhereClause` + `screen` where | `cache.ts`, `types.ts` |
| `packages/agent` | Tidak | Interface tetap |
| `packages/database`, `packages/shared`, `packages/execution` | Tidak (reuse) | Schema & migrasi tidak bertambah |
| `planning/`, `progress/phase-3/` | `phase-3.md` ini + `tasklist.md` + `design.md` + `rules.md` | `addendum_v3.0.md` locked |

## 4. Keputusan yang harus diambil sebelum coding

- LangGraph: **TIDAK diadopsi** — evaluasi tertulis di `progress/phase-3/design.md` (§27: premature abstraction). Gantikan dengan `WorkflowBuilder` 50-baris yang cukup untuk linear + satu conditional branch.
- Conditional debate: trigger = `stance === 'neutral'` atau `40 <= score <= 60` — satu ronde tambahan saja (Bear2 → Bull2 → Judge2 overwrite `judgment`), sequence_order 5–6. Tidak loop tak terbatas.
- Where SQL: mapping `profitable → roe>0`, `growing → revenue_growth>0` (dan `ni_growth` sebagai sinonim). `criteria` lain → fallback client-side (tidak kirim `where`).
- Urutan `where` vs `limit`: `GET /companies/?where=<encoded>&limit=200` — konsisten dengan `docs.sectors.app` v2.

## 5. Tasklist (TDD, `pnpm check` tiap commit)

Lihat `progress/phase-3/tasklist.md` — 4 task, masing-masing `test` → `implement` → `pnpm check`:

1. Workflow abstraction (`workflow.ts` + test) — **pending**
2. Conditional debate (`judgeWorkflow --conditional`, sequence 5–6, test E2E) — **pending**
3. Screener `where` SQL-native (`buildWhereClause` + `client.test.ts` where URL, fallback mock) — **pending**
4. Smoke Phase 3: `--mock-sectors --mock-llm` `/judge BBCA --conditional` + `/screen profitable` via where — **pending**

## 6. Verifikasi

- `pnpm typecheck` + `pnpm test` (E2E spawn CLI asli) tetap hijau sebelum commit Phase 3 pertama — base tidak ngedrift.
- Smoke `/judge BBCA --conditional` mock → 7 messages (0–6) bila neutral, 5 bila bullish; `/screen profitable` real memakai `where=roe>0` (bila key tersedia, kalau tidak mock tetap hijau).
- `Sectors API` real (`SECTORS_API_KEY` belum diisi) — hybrid hanya untuk smoke manual Phase 3 Task 4.

## 7. Risiko & mitigasi

- Conditional debate menambah token cost (2 LLM calls ekstra) → opt-in `--conditional`, default off, `maxTokens` §17 tetap.
- `where` SQL bisa 400 bila sintaks salah → fallback ke client-side scoring (catch `SectorsApiError` + retry tanpa `where`).
- LangGraph tidak diadopsi → docs evaluasi harus jelas agar tidak dianggap "lupa" (tulis di `ARCHITECTURE.md` Deviasi #22).
