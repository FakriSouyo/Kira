# Phase 4 — Session UX, History & Web Preview (GUI Vision Bridge)

> Dekomposisi pekerjaan yang bisa dieksekusi. Fondasi Phase 3 dianggap milestone bersih (191/191, workflow + conditional + where). Phase 4 = `GUI Vision Bridge` sesuai `addendum_v3.0.md §28`: jembatan menuju GUI tanpa Tauri — session UX di REPL + web preview JSONL.

## 1. Scope terkunci (apa & apa bukan)

**Masuk:**
- Session UX REPL: `/history [--limit N]` (listRuns), `/session <runId>` (getExecutionWithArtifacts + render), `/resume <runId>` (fork baru dari evidence lama — konten_hash dedup).
- Web preview mini: `apps/cli/src/repl/web.ts` — tiny HTTP server `GET /` (HTML) + `GET /api/run/:id` (artifacts JSON), `GET /api/history` (listRuns). Tidak pakai Tauri, hanya `node:http`.
- Renderer polish: tampilkan `conditional` marker di breakdown & conversation bila run memakai extra round.
- Agent-Events JSONL tetap pintu Go TUI/web/CI — web preview read dari DB, bukan dari events live.

**Keluar (deferred):**
- GUI Tauri penuh, pgvector, normalized tables — Future.
- Auth flow baru, streaming web via SSE — tidak di Phase 4.
- Worker-thread cancel asli — tetap best-effort.

## 2. Kontrak data (reuse DB)

- DB: `executions`, `evidence`, `agent_messages`, `claims`, `judgments` — reuse, tidak ada migrasi baru.
- `listRuns(limit, offset)` & `getExecutionWithArtifacts(runId)` sudah ada (Phase 2 Task 1).
- Web preview: read-only, tidak menulis DB.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `apps/cli/src/commands` | `history.ts`, `session.ts` (baru) + `index.ts` wiring | `workflows` (reuse) |
| `apps/cli/src/repl` | `web.ts` (baru, node:http), `loop.ts` tidak ubah | `parser.ts` |
| `apps/cli/src/repl/renderer.ts` | Polish conditional marker | `events.ts` |
| `packages/*` | Tidak | — |

## 4. Keputusan yang harus diambil sebelum coding

- `/history` default limit 20 (aman untuk terminal), `--limit` optional.
- `/session <runId>` → `renderExportMarkdown` reuse (audit trail), tanpa re-fetch.
- `/resume <runId>` → buat `new run_id` dengan `execution.createRun` + re-save evidence yang sama (dedup), lalu lanjut Bull→Judge tanpa re-fetch Sectors? Simpler: `/resume` hanya re-display (alias `/session`) di Phase 4 — fork penuh ditunda (butuh workflow ulang). Keputusan: `/resume` = alias `/session` + note.
- Web preview port default `3080` (tidak bentrok DSH 3080? DSH sudah di 3080 — pakai `3280` untuk finharness). Tidak auto-start; command `/web [--port N]` manual.

## 5. Tasklist (TDD, `pnpm check` tiap commit)

Lihat `progress/phase-4/tasklist.md` — 4 task:

1. `/history` + `/session` commands — **pending**
2. `/resume` alias + `web.ts` mini server — **pending**
3. Renderer polish conditional — **pending**
4. Smoke Phase 4: `--mock-sectors --mock-llm` → `/judge` → `/history` → `/session` → `web.test.ts` — **pending**

## 6. Verifikasi

- `pnpm check` hijau (191→ +新 tests).
- Smoke `/history` menampilkan run, `/session <id>` menampilkan FINAL JUDGMENT, `web.ts` `GET /api/history` 200 JSON.
- E2E tetap hijau (spawn CLI asli).

## 7. Risiko & mitigasi

- Port konflik DSH 3080 → default 3280, `--port` override.
- `/resume` full fork menambah kompleksitas — Phase 4 hanya alias, tidak re-run LLM (hemat token).
