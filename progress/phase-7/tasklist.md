# Phase 7 — Tasklist (Future Prototype)

> Sumber: `planning/phase-7.md`.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | Vector helper + searchEvidence | `packages/shared/src/vector.ts` `cosineSimilarity`, `mockEmbedding`, `packages/database/src/search.ts` `searchEvidence(runId?, query, limit?)` keywordOverlap + cosine tie-break | `packages/shared/test/vector.test.ts` (4): cosine, mockEmbedding deterministik, search ranking | `packages/shared/src/vector.ts`, `packages/database/src/search.ts` | **✓ done** (211/211) |
| 2 | `/search` command + renderer | `/search <query> [--run <id>] [--limit N]` via `searchEvidence` + `renderSearchResult` | `apps/cli/test/search.test.ts` (4): search, limit, render, last-run | `apps/cli/src/commands/search.ts`, `apps/cli/src/repl/renderer.ts` | **✓ done** (211/211) |
| 3 | Smoke + docs Future | Normalized vision DDL di `design.md` + smoke `--mock` → /judge → /search | Manual mock: pnpm check 211/211 + help contains /search | `progress/phase-7/design.md`, `ARCHITECTURE.md` | **✓ done** |

**Urutan:** 1 → 2 → 3.

**Status:** Phase 6 done 203/203 — gate Phase 7 hijau.
