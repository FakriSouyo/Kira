# Phase 2 — Advanced Features (Session, Streaming, Export)

> Dekomposisi pekerjaan yang bisa dieksekusi, bukan eksekusi penuh. Fondasi v2 (migrasi Sectors v1→v2, Deviasi #17 tertutup 2026-09-03) dianggap milestone bersih. Phase 1 sudah built: Debate ronde (Bear+Bull rebuttal) + Market & News Researcher (§24-A). Phase 2 = `Advanced Features` sesuai `addendum_v3.0.md §27`.

## 1. Scope terkunci (apa & apa bukan)

**Masuk:**
- Session save/resume: `executions` + `agent_messages` dapat di-resume atau di-replay tanpa re-fetch (reuse `evidence` dedup `content_hash`).
- Streaming + Agent-Events JSONL: `LLMClient.streamText` (Vercel `textStream`) sebagai jalur kedua **hanya untuk narasi/REPL** `message.delta`; `generateObject` tetap untuk klaim/judgment (dua jalur, Deviasi #21). `repl/events.ts` emit `session/phase/tool/evidence/message.delta` satu baris JSONL → pintu Go TUI/web/CI tanpa rewrite engine (default no-op, `judgeWorkflow(…, events)`).
- Export: `JSON`/`Markdown`/`HTML` dari `run_id` (audit trail lengkap `evidence` + `conversation` + `judgment.breakdown`).
- Skill-registry ringan (referensi DSH `§24-B.4`): katalog agent opsional (dividend, insider, sector, macro, technical, risk, ESG) — `FinharnessConfig.features` → filter registry, bukan plugin Cordis.

**Keluar (deferred):**
- Orchestration LangGraph/conditional workflow (§27 Phase 3) — belum ada consumer 2+ workflow.
- GUI Tauri Phase 4, pgvector / normalized tables Future.
- `where=` SQL screener native & `roe` real (§14b/18) — tetap deviasi diterima, tidak dikerjakan di Phase 2 kecuali ada permintaan `screen` real.

## 2. Kontrak data (tidak ada migrasi schema DB baru — reuse)

- DB: `executions` (state machine `running→completed|failed`), `evidence` (`UNIQUE content_hash`), `agent_messages` (`metadata.seenEvidenceIds`, `sequence_order`), `claims`, `judgments` (`breakdown` 5 kategori) — `packages/database/src/schema.ts:1` satu-satunya yang tahu `snake↔camel`.
- Canonical JSON: `packages/shared/src/prompt.ts` `renderEvidenceBlock` zona [1] byte-identical, `packages/evidence/src/hash.ts` dedup. Phase 2 tidak mengubah bentuk canonical.
- Sectors: `packages/sectors-api/src/client.ts:394` `SectorsClient` tetap `v2` (`/v2`, auth tanpa Bearer), `CompanyReport` sudah ada `yoyQuarter*` (§17 fix). Screener tetap client-side scoring (`computeMatchScore:56`) — Phase 2 tidak menyentuh `where`.
- LLM: `packages/llm/src/client.ts:22` `createProvider(baseURL/apiKey)` `.chat(model)` — dua-tier §17 tetap. Custom provider bitdeer (`https://api-inference.bitdeer.ai/v1`, `deepseek-ai/DeepSeek-V4-Flash`, `Qwen/Qwen3-30B-A3B`) sudah live-tested `generateText Hello! OK`, `generateObject` full-judge hit `insufficient balance` pada 2026-09-03 — butuh top-up sebelum smoke real penuh. Phase 2 Task 2: `LLMClientLike.streamText() → AsyncIterable<string>` (Vercel `streamText → textStream`, tanpa `withRetry`) — klaim/judgment tetap `generateObject`.
- Config: `apps/cli/src/config.ts:51` `.credentials.json` (0600) + `config.json` non-secret, `ENV` `LLM_BASE_URL`/`LLM_API_KEY` — Phase 2 menambah `features.session_resume` & `features.streaming` boolean, bukan key baru.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `apps/cli` (REPL, workflows, renderer) | `repl/` streaming, `commands/export`, `commands/session`, `screenWorkflow` (jika `where` ditunda = tidak) | `agent` pure functions |
| `packages/agent` | Prompt streaming chunk handler (optional) | Interface `analyze`/`challenge`/`evaluate` tetap `generateObject` |
| `packages/database` | Query `getByRun` sudah ada; tambah `listRuns`/`resumeRun` helper (read-only) | Schema & migrasi tidak bertambah |
| `packages/sectors-api`, `packages/llm`, `packages/shared`, `packages/execution` | Tidak | — |
| `planning/`, `progress/phase-2/` | `phase-2.md` ini + `tasklist.md` | `addendum_v3.0.md` locked |

## 4. Keputusan yang harus diambil sebelum coding

- Streaming: `Vercel AI SDK generateText.stream` vs `generateObject` + `onChunk` — **DIKUNCI Task 2**: `streamText` untuk REPL (`message.delta`), `generateObject` tetap untuk `claims`/`judgment` Zod (dua jalur, Deviasi #21). `LLMClient.streamText` → `textStream` tanpa `withRetry`.
- Session: resume = re-run workflow dari `execution` existing atau fork `new run_id` yang referensi `evidence` lama? Keputusan: fork baru (audit trail immutable, `content_hash` dedup otomatis).
- Export: format `JSON` = dump DB row; `Markdown`/`HTML` = renderer `apps/cli/src/repl/renderer.ts` + `packages/shared/src/rubric.ts` skor deterministik — single template, tidak perlu Tauri.
- Skill-registry: `packages/agent/src/registry.ts` `[{name, description, promptBuilder, evidenceSources, featureFlag}]` — `--with dividend risk` filter, bukan Cordis `preset` YAML.
- Agent-Events JSONL: **DIKUNCI Task 2** — `apps/cli/src/repl/events.ts` satu baris JSON per event (`session/phase/tool/evidence/message.delta`), `judgeWorkflow(…, events)` default no-op, pintu Go TUI/web/CI. Dipilih **Tetap TS + emit Agent-Events JSONL** (bukan rewrite Go penuh).

## 5. Tasklist (TDD, `pnpm check` tiap commit)

Lihat `progress/phase-2/tasklist.md` — 6 task, masing-masing `test` → `implement` → `pnpm check`:

1. Session store helpers (`listRuns`, `getExecutionWithArtifacts`) — **✓ done**
2. Streaming + Agent-Events JSONL (`LLMClient.streamText` + `repl/events.ts` + `judgeWorkflow(…, events)`) — **✓ done** (160/160)
3. Export JSON/Markdown/HTML (`commands/export.ts`)
4. Skill-registry ringan (`packages/agent/registry.ts`, `--with` flag)
5. E2E `record/replay` fixture keyless (§24-B.2) untuk Phase 2
6. Smoke Phase 2: `--mock-sectors --mock-llm` + bitdeer real (setelah top-up)

## 6. Verifikasi

- `pnpm typecheck` + `pnpm test` (E2E spawn CLI asli) tetap hijau sebelum commit Phase 2 pertama — base tidak ngedrift.
- Smoke `/judge BBCA` hybrid (`--mock-sectors` + bitdeer real `deepseek-ai/DeepSeek-V4-Flash`) — `generateText` OK 2026-09-03, full `judgeWorkflow` tertunda `insufficient balance` (bukan bug kode) — re-smoke setelah top-up.
- `Sectors API` real (`SECTORS_API_KEY` belum diisi) — hybrid saja untuk Phase 2; full real butuh key.

## 7. Risiko & mitigasi

- Token cost streaming + `generateObject` 5 agent → `maxTokens` §17 tetap 2000/256, streaming tidak menambah token.
- `where`/`roe` screener tetap deviasi diterima Fase 2 — tidak memblokir session/streaming/export.
- Bitdeer balance habis → fallback `--mock-llm` untuk TDD, real hanya smoke manual.
