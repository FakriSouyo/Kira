# Design — Phase 9A (Real Future)

Tracking; source `planning/phase-9.md`.

## Tujuan

Normalized tables real + embedding fallback + abort plumbing (real minimal, masih offline-safe).

## Keputusan

| Aspek | Keputusan | Lokasi |
|---|---|---|
| Normalized | real migration `0002` + helper | `packages/database/*` |
| Embedding | `getEmbedding` fallback mock | `packages/shared/src/vector.ts` |
| Abort | `signal` check di `Workflow.run` + `judgeWorkflow` | `apps/cli/src/workflows/*` |

## Delta

- **Task 1–3 (done, 219/219):** `0002_normalized.sql` (IF NOT EXISTS, `financials_normalized`/`daily_normalized` UNIQUE), `schema.ts` + `NormalizedStore` upsert `onConflictDoUpdate`, `vector.ts` `getEmbedding` (LLM→fallback mock), `Workflow.run({signal})` + `judgeWorkflow({signal})` checkAbort before researcher/conditional. `normalized.test.ts` (4) + `abort.test.ts` (4) hijau; `pnpm check` 219/219 (35 files).
