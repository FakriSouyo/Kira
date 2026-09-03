# Phase 4 — Tasklist (TDD, `pnpm check` tiap commit)

> Sumber: `planning/phase-4.md`. Setiap task: test dulu, implement, lalu `pnpm check` hijau.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | `/history` + `/session` | `/history [--limit N]` listRuns, `/session <runId>` getExecutionWithArtifacts + render markdown | `apps/cli/test/history.test.ts` (3): history lists, session shows judgment, NOT_FOUND | `apps/cli/src/commands/history.ts` | **✓ done** (197/197) |
| 2 | `/resume` alias + web preview | `/resume <runId>` alias session; `repl/web.ts` `createWebServer(db, port)` GET / + /api/history + /api/run/:id | `apps/cli/test/web.test.ts` (3): GET / 200, GET /api/history 200, GET /api/run/:id 200/404 | `apps/cli/src/repl/web.ts`, `history.ts` resume | **✓ done** (197/197) |
| 3 | Renderer polish | Conditional marker di `renderJudgeResult` & `renderExportMarkdown` bila metadata.conditional | Implicit via history/web + conditionalUsed badge | `apps/cli/src/repl/renderer.ts`, `workflows/judgeWorkflow.ts` conditionalUsed | **✓ done** (197/197) |
| 4 | Smoke Phase 4 | `--mock-sectors --mock-llm` → /judge → /history → /session + web server start | Manual mock: pnpm check 197/197 + web.test | — | **✓ mock done** |

**Urutan:** 1 → 2 → 3 → 4. Commit tiap task.

**Status terbaru:** Phase 3 done 191/191 — gate Phase 4 hijau.
