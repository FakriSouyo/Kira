# Phase 9A — Tasklist (Real Future)

> Sumber: `planning/phase-9.md`.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | Normalized migration | `0002_normalized.sql` + `schema.ts` + `normalized.ts` helper read/write idempotent | `packages/database/test/normalized.test.ts` (4): create, upsert overwrite, daily, idempotent | `packages/database/*` | **✓ done** (219/219) |
| 2 | Real embedding + abort | `vector.ts` `getEmbedding` fallback mock, `workflow.ts` + `judgeWorkflow` signal plumbing | `packages/shared/test/vector.test.ts` + `apps/cli/test/abort.test.ts` (4): fallback, abort before step | `packages/shared/src/vector.ts`, `apps/cli/src/workflows/*` | **✓ done** (219/219) |
| 3 | Smoke + docs | Migration + search tetap hijau + eval | `pnpm check` 219/219 + help | `progress/phase-9/design.md`, `ARCHITECTURE.md` | **✓ done** |

**Urutan:** 1 → 2 → 3.

**Status:** Phase 8 done 211/211 (`0.3.0`).
