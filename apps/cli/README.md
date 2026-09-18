# @harness/cli

REPL interaktif — satu-satunya UI harness. Jalankan: `pnpm finharness` (tambah `--mock-sectors --mock-llm` untuk offline, `--home <dir>` untuk data dir kustom).

| Modul | Isi |
|---|---|
| `index.ts` | Entry: parse arg → `loadConfig` → `openDb` → `createHarnessSession` → REPL; slash commands remain workflow-owned and natural language uses `MainFinHarnessAgent` |
| `config.ts` | `loadConfig` — prioritas **env → `.credentials.json` → `config.json` → default**; `FinharnessConfig`; custom provider via `base_url`/`api_key` per-tier (file) atau `LLM_BASE_URL`/`LLM_API_KEY` (env, kedua tier), with optional per-tier `context_window_tokens` capability metadata. Key mentah preferensi di `.credentials.json` (`~/.finharness/.credentials.json`) — ditulis command `/auth-set` (mode 0600), bukan config.json |
| `context.ts` | `buildContext` — wiring dua-tier LLM + Sectors API + store + validator |
| `workflows/judgeWorkflow.ts` | Researcher → Bull → validasi → **Bear (challenge) → Bull (rebuttal)** → Judge (Phase 1 Debate ronde); lifecycle calls receive execution-scoped typed specialist context and snapshots; persist run/evidence/messages/claims/judgment; error → run `failed` + `UserFriendlyError` |
| `workflows/screenWorkflow.ts` | `sectors.screen` → filter skor > 0 → top 10 |
| `repl/` | `parser.ts` (slash vs natural language), `loop.ts` (tab completion, Ctrl+C, line queue), `renderer.ts` (layout §19, ANSI) |
| `commands/` | `/judge`, `/screen`, `/auth-set`, `/help`, `/exit` + stub roadmap (challenge/compare/research/investigate) |
| `migrate.ts` | `pnpm db:migrate` — jalankan migrasi saja |

Catatan:
- CLI adalah satu-satunya tempat yang menulis DB; agent (`@harness/agent`) tetap pure.
- Conversational follow-up pipeline: canonical Turn → capture one `SessionWorkingContext` version → deterministic focus → Resolver → Policy → Assembler → `ContextPacket` → deterministic token budget/structural compaction → final `ContextPacket` → `ContextSnapshot` → reused deterministic renderer → `MainFinHarnessAgent` → turn-owned `ModelCall.contextSnapshotId`. Context-free turns skip budgeting and snapshots; impossible required budgets fail before model invocation.
- Ordinary follow-ups reuse prior typed artifacts without rerunning `/judge` or calling Sectors. Snapshot context is prior research state, not a fresh provider fetch; context-free model calls keep a null snapshot link.
- `/judge` continues through the command map and WorkflowRunner; it is not rerouted through the conversational agent.
- Lifecycle `/judge` specialist calls receive role/phase-specific context assembled from current execution Evidence and upstream typed debate outputs. The canonical Evidence zone remains shared across Bull, Bear, and Judge; no provider freshness, retrieval, history search, or cross-session context is introduced here.
- E2E (`test/e2e.test.ts`) spawn proses CLI asli dengan mock mode dan memverifikasi output + state DB.
- Ctrl+C saat executing = best-effort (berhenti di batas fase berikutnya) — lihat ARCHITECTURE.md → Deviations #8.
