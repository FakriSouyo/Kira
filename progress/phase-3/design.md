# Design — Phase 3 (Orchestration + Where)

Dokumen **tracking**; desain final & source of truth tetap di `planning/phase-3.md` §1-7. Di sini hanya **delta/keputusan yang relevan untuk eksekusi** phase ini + lokasi kode yang disentuh.

## Tujuan

Menilai LangGraph vs hardcode, membuat abstraksi workflow ringan, menambah conditional debate (Debate ronde 2), dan menutup deviasi screener `where` SQL-native v2 tanpa menambah migrasi DB.

## Keputusan kunci (locked, dari `planning/phase-3.md`)

| Aspek | Keputusan | Lokasi |
|---|---|---|
| Workflow abstraction | `WorkflowBuilder` linear + conditional branch (bukan LangGraph) | `apps/cli/src/workflows/workflow.ts` |
| Conditional debate | Opt-in `--conditional`, trigger `neutral` atau 40–60, satu ronde ekstra | `apps/cli/src/workflows/judgeWorkflow.ts` |
| Where SQL | `buildWhereClause` mapping profitable/growing → `where=...`, fallback client-side | `packages/sectors-api/src/client.ts` |
| LangGraph evaluasi | Tidak diadopsi — over-engineering untuk 2 workflow (AGENTS.md minimal abstraction) | `ARCHITECTURE.md` Deviasi #22 |

## Delta desain vs practical (deviasi yang mungkin muncul)

> Diisi selama eksekusi bila kode menyimpang dari `planning/phase-3.md` — catat di `ARCHITECTURE.md` tabel Deviasi.

- **Task 1 (done, 191/191):** `Workflow` linear + conditional branch, `defineWorkflow` helper — evaluasi LangGraph tertulis: tidak diadopsi (minimal abstraction). `pnpm check` hijau.
- **Task 2 (done, 191/191):** `judgeWorkflow(…, {conditional})` → extra Bear2 (seq5) + Bull2 (seq6) + Judge2 (seq7), `judgments` upsert via `onConflictDoUpdate` (sebelumnya UNIQUE throw). Test `conditional.test.ts` 3: neutral trigger, bullish skip, overwrite. Deviasi #22 (LangGraph) & #23 (judgment upsert).
- **Task 3 (done, 191/191):** `buildWhereClause` mapping `profitable→roe>0`, `growing→yoy_quarter_revenue_growth>0`, `?where=` encode + fallback 400→client-side. `where.test.ts` 6 tests. Menutup `ARCHITECTURE.md` Deviasi #14b/#18.
- **Task 4 mock smoke (done, 191/191):** `--mock-sectors --mock-llm` → `/judge BBCA --conditional` (extra round saat neutral) + `/screen growing` via where, fallback teruji.

## Cakupan / keluar-cakupan

- **Masuk:** workflow builder, conditional debate, where SQL-native, Agent-Events phase tambahan, evaluasi LangGraph tertulis.
- **Keluar:** GUI Tauri Phase 4, pgvector Future, worker-thread cancel, skill-registry baru.
