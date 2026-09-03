# Rules — Phase 4

Konvensi khusus Phase 4.

## Session commands

- `/history [--limit N]` → `db.execution.listRuns({limit})`; limit default 20, max 100. Output: `runId  ticker  status  score`.
- `/session <runId>` → `getExecutionWithArtifacts`; NOT_FOUND → UserFriendlyError. Render via `renderExportMarkdown` (reuse Phase 2 export).
- `/resume <runId>` → alias `/session` di Phase 4 (fork penuh ditunda). Tampilkan note `Resume (Phase 4): displaying session <id> — full re-run deferred`.

## Web preview

- `createWebServer(db, {port})` → `http.createServer`; routes: `GET /` (HTML list), `GET /api/history`, `GET /api/run/:id`. Read-only, no auth.
- Default port 3280 (hindari DSH 3080). `listen` + `close` untuk test.
- Tidak auto-start REPL; command `/web [--port N]` manual (Phase 4 Task 2).

## Pengujian

- TDD, `pnpm check` hijau. Mock deterministik.
