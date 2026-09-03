# Phase 5 — Tasklist

> Sumber: `planning/phase-5.md`.

| # | Task | Kontrak | Test utama | Berubah | Status |
|---|------|---------|------------|---------|--------|
| 1 | Version + banner | `apps/cli/src/commands/version.ts` + `renderer.renderBanner(version)` dinamis, `pnpm finharness --version` flag | `apps/cli/test/version.test.ts` (3): version format, banner contains version, --version flag | `apps/cli/*`, `package.json` | **✓ done** (203/203) |
| 2 | Metrics helper | `packages/shared/src/metrics.ts` `formatDuration`, `/history` kolom Time | `packages/shared/test/metrics.test.ts` (3): <1s, 12.3s, history time | `packages/shared/src/metrics.ts`, `apps/cli/src/commands/history.ts` | **✓ done** (203/203) |
| 3 | Help polish + smoke | `renderHelp` update + smoke | Manual mock: pnpm check 203/203 + help contains history/session/web | `apps/cli/src/repl/renderer.ts` | **✓ done** (203/203) |

**Urutan:** 1 → 2 → 3.

**Status:** Phase 4 done 197/197.
