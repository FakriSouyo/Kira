# Phase 3 — Tasklist (TDD, `pnpm check` tiap commit)

> Sumber: `planning/phase-3.md`. Eksekusi berbasis tasklist, bukan langsung coding penuh. Setiap task: tulis test dulu (`packages/**/test`, `apps/cli/test`), lalu implementasi, lalu `pnpm check` (typecheck + test) hijau.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | Workflow abstraction | `apps/cli/src/workflows/workflow.ts` `WorkflowBuilder` linear + conditional branch, `defineWorkflow` helper; dipakai `judgeWorkflow` tanpa ubah kontrak agent | `apps/cli/test/workflow.test.ts` (5): linear, conditional taken/skipped, fail-closed, events | `apps/cli/src/workflows/workflow.ts` | **✓ done** (191/191) |
| 2 | Conditional debate | `judgeWorkflow(ctx, ticker, progress, events, { conditional })` — bila neutral (40–60) jalankan Bear2→Bull2→Judge2, sequence 5–7, `judgment` overwrite via upsert | `apps/cli/test/conditional.test.ts` (3): neutral triggers extra, bullish no extra, sequence 5–7 | `apps/cli/src/workflows/judgeWorkflow.ts` + `judgmentStoreSqlite` upsert | **✓ done** (191/191) |
| 3 | Screener where SQL | `buildWhereClause(criteria) → string | null`, `SectorsClient.screen` kirim `?where=` v2 untuk profitable/growing, fallback client-side | `packages/sectors-api/test/where.test.ts` (6): mapping, where URL, fallback 400 | `packages/sectors-api/src/client.ts` | **✓ done** (191/191) |
| 4 | Smoke Phase 3 | Hybrid `--mock-sectors --mock-llm` `/judge BBCA --conditional` + `/screen profitable` via where | Manual mock: `pnpm check` 191/191 + conditional E2E; hybrid real tertunda key | — | **✓ mock done** |

**Urutan eksekusi:** 1 → 2 → 3 → 4. Commit tiap task: `feat(phase-3): <task>` + `pnpm check` log.

**Status terbaru:** Phase 2 done 177/177 — gate Phase 3 hijau, siap eksekusi.
