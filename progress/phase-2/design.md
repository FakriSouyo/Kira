# Design — Phase 2 (Session, Streaming, Export)

Dokumen **tracking**; desain final & source of truth tetap di `planning/phase-2.md` §1-7. Di sini hanya **delta/keputusan yang relevan untuk eksekusi** phase ini + lokasi kode yang disentuh.

## Tujuan

Menambah `Session save/resume`, `Streaming output`, `Export (json/md/html)` dan `Skill-registry` ringan agar run `/judge` dapat di-resume tanpa re-fetch (reuse `content_hash` dedup), REPL streaming per-token, dan audit trail dapat di-dump — tanpa migrasi schema DB baru, mengikuti pola `deepseek-harness` yang worth steal tanpa Cordis.

## Keputusan kunci (locked, dari `planning/phase-2.md`)

| Aspek | Keputusan | Lokasi |
|---|---|---|
| Session helpers | `ExecutionStore.listRuns()` + `getExecutionWithArtifacts(runId)` read-only (fork baru, bukan overwrite) | `packages/database/src/executionStoreSqlite.ts`, `client.ts` `FinharnessDatabase` |
| Streaming | `LLMClient.streamText` per token untuk REPL; `claims/judgment` tetap `generateObject` Zod | `packages/llm/src/client.ts`, `apps/cli/src/repl/stream.ts` |
| Export | `/export <runId> [--format json|md|html]` dari `runId` existing | `apps/cli/src/commands/export.ts`, `repl/renderer.ts` |
| Skill-registry | `packages/agent/src/registry.ts` `[{name, evidenceSources, featureFlag, promptBuilder}]`, `--with dividend risk` filter | `packages/agent`, `apps/cli/src/config.ts` `features` |
| Replay fixture | `progress/phase-2/fixtures/bbca.jsonl` keyless `record/replay/refresh` (§24-B.2) | `apps/cli/test/replay.test.ts` |
| Degradasi | Export/streaming gagal → run `completed`; validasi gagal eksekusi → `failed` | `judgeWorkflow.ts`, `claimValidator.ts` |
| Config | `features.session_resume`, `features.streaming` boolean (no new secret) | `apps/cli/src/config.ts` |

## Delta desain vs practical (deviasi yang mungkin muncul)

> Diisi selama eksekusi bila kode menyimpang dari `planning/phase-2.md` — catat di `ARCHITECTURE.md` tabel Deviasi.

- **Task 1 (done `ee3b2cd`, hijau 150/150):** `getExecutionWithArtifacts` memetakan baris evidence/messages/claims/judgment **manual inline** (bukan reuse `toEvidence` existing di `evidenceStoreSqlite.ts`) → dicatat ARCHITECTURE Deviasi **#19**. `listRuns` default `limit 100` (aman untuk CLI). Resume = fork baru (`content_hash` dedup) sesuai `rules.md` — belum ada consumer command `/resume` (addendum §27 list fitur), helper sudah siap untuk Task 2/3.
- **Refactor #19 (done, diputuskan sebelum fitur baru):** `toEvidence`/`EvidenceRow` di-`export` dari `evidenceStoreSqlite.ts`; `getExecutionWithArtifacts` kini reuse `toEvidence` untuk evidence (bukti: `getExecutionWithArtifacts().evidence toEqual getByRun()` di `session.test.ts`). Deviasi #19 ditandai TERTUTUP di ARCHITECTURE. `pnpm check` hijau.
- **Task 2 (done, 160/160):** `LLMClient.streamText` (Vercel `streamText → textStream`, tanpa `withRetry`) + `MockLLMClient.streamText` (3 chunk deterministik) + `FakeLLM` stub memenuhi `LLMClientLike`. `Agent-Events` JSONL `apps/cli/src/repl/events.ts` (`serializeAgentEvent`, `createEventSink`, `AgentEvent` union) — `judgeWorkflow(…, events)` default no-op, dipicu per tool/evidence/phase/session, **E2E tak berubah**. Dibuktikan `stream.test.ts` (3), `agent-events.test.ts` (4), `workflow-events.test.ts` (2). ARCHITECTURE Deviasi #21 (dua jalur). `pnpm check` 160/160.

## Cakupan / keluar-cakupan

- **Masuk:** `listRuns`/`getExecutionWithArtifacts`, streaming `streamText`, export `json/md/html`, skill-registry `--with`, replay fixture keyless, E2E `record/replay`, smoke hybrid bitdeer (`deepseek-ai/DeepSeek-V4-Flash` @ `https://api-inference.bitdeer.ai/v1` — 2026-09-03 `generateText Hello! OK`, full `generateObject` `insufficient balance` perlu top-up).
- **Keluar:** `where` SQL screener & `roe` real (`ARCHITECTURE.md #14b/18` diterima), LangGraph Phase 3, GUI Tauri Phase 4, pgvector Future, `worker-thread` cancel.
