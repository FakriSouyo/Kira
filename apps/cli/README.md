# @harness/cli

REPL interaktif — satu-satunya UI harness. Jalankan: `pnpm finharness` (tambah `--mock-sectors --mock-llm` untuk offline, `--home <dir>` untuk data dir kustom).

| Modul | Isi |
|---|---|
| `index.ts` | Entry: parse arg → `loadConfig` → `openDb` → `buildContext` → REPL; handler natural language via `IntentRouter` |
| `config.ts` | `loadConfig` — prioritas **env → `config.json` → default**; `FinharnessConfig`; custom provider via `base_url`/`api_key` per-tier (file) atau `LLM_BASE_URL`/`LLM_API_KEY` (env, kedua tier) |
| `context.ts` | `buildContext` — wiring dua-tier LLM + Sectors API + store + validator |
| `workflows/judgeWorkflow.ts` | Researcher → Bull → validasi → Judge; persist run/evidence/messages/claims/judgment; error → run `failed` + `UserFriendlyError` |
| `workflows/screenWorkflow.ts` | `sectors.screen` → filter skor > 0 → top 10 |
| `repl/` | `parser.ts` (slash vs natural language), `loop.ts` (tab completion, Ctrl+C, line queue), `renderer.ts` (layout §19, ANSI) |
| `commands/` | `/judge`, `/screen`, `/help`, `/exit` + stub roadmap (challenge/compare/research/investigate) |
| `migrate.ts` | `pnpm db:migrate` — jalankan migrasi saja |

Catatan:
- CLI adalah satu-satunya tempat yang menulis DB; agent (`@harness/agent`) tetap pure.
- E2E (`test/e2e.test.ts`) spawn proses CLI asli dengan mock mode dan memverifikasi output + state DB.
- Ctrl+C saat executing = best-effort (berhenti di batas fase berikutnya) — lihat ARCHITECTURE.md → Deviations #8.
