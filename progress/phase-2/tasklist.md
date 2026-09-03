# Phase 2 — Tasklist (TDD, `pnpm check` tiap commit)

> Sumber: `planning/phase-2.md`. Eksekusi berbasis tasklist, bukan langsung coding penuh. Setiap task: tulis test dulu (`packages/**/test`, `apps/cli/test`), lalu implementasi, lalu `pnpm check` (typecheck + test) hijau.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | Session helpers | `ExecutionStore.listRuns()` + `getExecutionWithArtifacts(runId)` → `Evidence[]` + `AgentMessage[]` + `Claims` + `Judgment` reuse `content_hash` dedup | `packages/database/test/session.test.ts`: list, get existing, `run_id` tak ada → `NOT_FOUND` | `packages/database` helper read-only, no migrasi | **✓ done** (`ee3b2cd`) |
| 2 | Streaming REPL | `repl/stream.ts` `streamText` per token, `Ctrl+C` best-effort di batas fase (worker-thread deferred) | `apps/cli/test/stream.test.ts`: mock LLM stream chunk → renderer memanggil `onChunk` 3×, cancel di fase `bull` | `apps/cli/src/repl/*`, `packages/llm` `streamText` | pending |
| 3 | Export run | `/export <runId> [--format json\|md\|html]` dump audit trail | `apps/cli/test/export.test.ts`: spawn CLI `--mock-sectors --mock-llm` `/judge BBCA` lalu `/export run_... --format md` → file berisi `BBCA · FINAL JUDGMENT` + tabel `breakdown` | `apps/cli/src/commands/export.ts`, `apps/cli/src/repl/renderer.ts` | pending |
| 4 | Skill-registry ringan | `packages/agent/src/registry.ts` `[{name, description, evidenceSources, featureFlag, promptBuilder}]`, `--with dividend risk` filter | `packages/agent/test/registry.test.ts`: `--with dividend` → Bull prompt mengandung `dividendYield`, tanpa flag → tidak | `packages/agent`, `apps/cli/src/config.ts` `features` | pending |
| 5 | Replay fixture keyless | `progress/phase-2/fixtures/bbca.jsonl` = input mock + expected snapshot (§24-B.2) `record/replay/refresh` | `apps/cli/test/replay.test.ts`: `replay` mode bandingkan `judgment.score` & `sequence_order` vs snapshot | `apps/cli/test`, `packages/llm` mock | pending |
| 6 | Smoke Phase 2 | Hybrid `--mock-sectors` + bitdeer real `deepseek-ai/DeepSeek-V4-Flash` (`LLM_BASE_URL` `https://api-inference.bitdeer.ai/v1`) streaming + export | Manual: `pnpm finharness --mock-sectors` `/judge BBCA` → `/export` → file ada; re-smoke setelah top-up bitdeer (2026-09-03 `insufficient balance` pada `generateObject` penuh) | — | pending |

**Urutan eksekusi:** 1 → 2 → 3 → 4 → 5 → 6. Commit tiap task: `feat(phase-2): <task>` + `pnpm check` log.

**Status terbaru (2026-09-03):** Task 1 **selesai & hijau** (`ee3b2cd`, `session.test.ts` 5 test). **Gate sebelum task 2:** `pnpm check` di `master` (base kini `ee3b2cd` + deviasi #17/#18) harus hijau — jangan mulai task berikutnya di atas base ngedrift.