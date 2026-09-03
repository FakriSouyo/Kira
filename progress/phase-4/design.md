# Design — Phase 4 (Session UX + Web Preview)

Dokumen tracking; source of truth `planning/phase-4.md`.

## Tujuan

Menambah UX sesi di REPL (history/session/resume) dan jembatan GUI Vision via tiny web preview (node:http), tanpa Tauri, tanpa migrasi DB.

## Keputusan kunci

| Aspek | Keputusan | Lokasi |
|---|---|---|
| `/history` | `listRuns({limit})` → renderer list | `apps/cli/src/commands/history.ts` |
| `/session` | `getExecutionWithArtifacts(runId)` → `renderExportMarkdown` | `apps/cli/src/commands/session.ts` |
| `/resume` | Alias `/session` + note (fork penuh deferred) | `apps/cli/src/commands/session.ts` |
| Web preview | `createWebServer(db, port)` GET / (HTML), GET /api/history, GET /api/run/:id | `apps/cli/src/repl/web.ts` |
| Renderer | Conditional badge bila `judgment.metadata.conditional` atau messages 8 | `apps/cli/src/repl/renderer.ts` |

## Delta desain vs practical

- **Task 1–2 (done, 197/197):** `history.ts` (`/history` `--limit`, `/session`, `/resume` alias) + `web.ts` tiny `node:http` server (GET /, /api/history, /api/run/:id). `/resume` Phase 4 hanya alias display (fork penuh deferred). Test `history.test.ts` (3) + `web.test.ts` (3) hijau.
- **Task 3 (done):** `JudgeArtifacts.conditionalUsed` + `renderer` badge `(conditional extra round)` & markdown `Conditional` marker via `messages.metadata.conditional`. Tanpa tambahan test khusus (teruji via history/web).
- **Task 4 mock smoke (done, 197/197):** `--mock` → /judge → /history → /session → web server, pnpm check 197/197.
