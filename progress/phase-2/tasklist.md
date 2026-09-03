# Phase 2 — Tasklist (TDD, `pnpm check` tiap commit)

> Sumber: `planning/phase-2.md`. Eksekusi berbasis tasklist, bukan langsung coding penuh. Setiap task: tulis test dulu (`packages/**/test`, `apps/cli/test`), lalu implementasi, lalu `pnpm check` (typecheck + test) hijau.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | Session helpers | `ExecutionStore.listRuns()` + `getExecutionWithArtifacts(runId)` → `Evidence[]` + `AgentMessage[]` + `Claims` + `Judgment` reuse `content_hash` dedup | `packages/database/test/session.test.ts`: list, get existing, `run_id` tak ada → `NOT_FOUND` | `packages/database` helper read-only, no migrasi | **✓ done** (`ee3b2cd`) |
| 2 | Streaming + Agent-Events | `LLMClient.streamText` (Vercel `textStream`, dua jalur) + `repl/events.ts` JSONL (`session/phase/tool/evidence/message.delta`) + `judgeWorkflow(…, events)` default no-op | `packages/llm/test/stream.test.ts` (3), `apps/cli/test/agent-events.test.ts` (4), `apps/cli/test/workflow-events.test.ts` (2) | `packages/llm`, `apps/cli/src/repl/events.ts`, `apps/cli/src/workflows/judgeWorkflow.ts` | **✓ done** (160/160) |
| 3 | Export run | `/export <runId> [--format json\|md\|html]` dump audit trail | `apps/cli/test/export.test.ts` (6): json/md/html/--out, NOT_FOUND, INVALID_ARG | `apps/cli/src/commands/export.ts`, `apps/cli/src/repl/renderer.ts` | **✓ done** (177/177) |
| 4 | Skill-registry ringan | `packages/agent/src/registry.ts` `[{name, description, evidenceSources, featureFlag, promptBuilder}]`, `--with dividend risk` filter | `packages/agent/test/registry.test.ts` (8): filter/build, dividendYield, canonical sources | `packages/agent/src/registry.ts` | **✓ done** (177/177) |
| 5 | Replay fixture keyless | `progress/phase-2/fixtures/bbca.jsonl` = input mock + expected snapshot (§24-B.2) `record/replay/refresh` | `apps/cli/test/replay.test.ts` (3): load fixture, replay deterministik, compareSnapshot | `apps/cli/src/repl/replay.ts`, `progress/phase-2/fixtures/bbca.jsonl` | **✓ done** (177/177) |
| 6 | Smoke Phase 2 | Hybrid `--mock-sectors` + bitdeer real `deepseek-ai/DeepSeek-V4-Flash` (`LLM_BASE_URL` `https://api-inference.bitdeer.ai/v1`) streaming + export | Manual: `pnpm finharness --mock-sectors` `/judge BBCA` → `/export` → file ada; re-smoke setelah top-up bitdeer (2026-09-03 `insufficient balance` pada `generateObject` penuh) | — | pending |

**Urutan eksekusi:** 1 → 2 → 3 → 4 → 5 → 6. Commit tiap task: `feat(phase-2): <task>` + `pnpm check` log.

**Status terbaru (2026-09-03):** Task 1–5 **selesai & hijau** (`pnpm check` **177/177**, 24 files). **Gate sebelum task 6:** base kini Task 5 + deviasi #17–#21, `pnpm check` hijau — siap smoke manual.