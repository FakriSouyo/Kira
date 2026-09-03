# Design — Phase 5

Tracking; source `planning/phase-5.md`.

## Tujuan

Version dinamis, metrics polish, help & distribution prep.

## Keputusan

| Aspek | Keputusan | Lokasi |
|---|---|---|
| Version | `package.json` `0.2.0-rc` + `/version` | `apps/cli/src/commands/version.ts` |
| Banner | `renderBanner(version)` dinamis | `apps/cli/src/repl/renderer.ts` |
| Metrics | `formatDuration` | `packages/shared/src/metrics.ts` |
| History | Kolom `Time Xs` | `apps/cli/src/commands/history.ts` |

## Delta

- **Task 1–3 (done, 203/203):** `VERSION` dinamis dari `package.json` (fallback `0.1.0`), banner `v${VERSION}`, `formatDuration`, `/history` `Time`, `renderHelp` lengkap (history/session/resume/web/export/version). `version.test.ts` (3) + `metrics.test.ts` (3) hijau; `pnpm check` 203/203.
