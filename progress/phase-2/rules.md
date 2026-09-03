# Rules — Phase 2 (Session, Streaming, Export)

Konvensi khusus Phase 2 yang **belum** tercakup di `AGENTS.md` / `ARCHITECTURE.md`.
Aturan global tetap di `AGENTS.md`; dokumen ini hanya delta.

## Kontrak session & export

- Session helper **read-only**, tanpa migrasi schema: `ExecutionStore.listRuns()` + `getExecutionWithArtifacts(runId)` → `{ run, evidence, messages, claims, judgment }`. Reuse `evidence` dedup `content_hash` — resume = fork `new run_id` yang referensi `evidence` lama, bukan overwrite `executions` existing.
- `runId` tak ada → `NOT_FOUND` (`UserFriendlyError` code `NOT_FOUND`, bukan `null` silent).
- Export `/export <runId> [--format json|md|html]` dump audit trail lengkap (`evidence` + `conversation` + `judgment.breakdown`). `json` = DB rows verbatim; `md`/`html` = renderer `apps/cli/src/repl/renderer.ts` + `normalizeJudgmentScore` deterministik.

## Streaming & cancellation

- Streaming hanya via `LLMClient.streamText` (Vercel AI SDK `streamText → textStream`) untuk REPL per-token (`message.delta`); `claims`/`judgment` tetap `generateObject` Zod (dua jalur, Deviasi #21). `maxTokens` §17 tetap 2000/256 — streaming tidak menambah biaya token. Tanpa `withRetry` (stream tak bisa di-retry tengah jalan).
- `Ctrl+C` best-effort di batas fase (researcher→bull→bear→judge). `worker-thread` cancellation deferred (referensi DSH `§24-B.4`), tidak dikerjakan Phase 2.

## Agent-Events JSONL (Task 2)

- `apps/cli/src/repl/events.ts`: `AgentEvent` union (`session.start/complete`, `phase`, `tool.start/complete`, `evidence.found`, `message.delta`) → `serializeAgentEvent` satu baris JSON, `createEventSink(output?)` (no-op bila tanpa output). Pintu Go TUI/web/CI.
- `judgeWorkflow(ctx, ticker, progress, events)` — `events` default no-op; dipicu `tool` per `SECTORS_SOURCES`, `evidence` per save, `phase` per fase, `session` start/complete. Consumer: `for await (const c of client.streamText(...))` → `message.delta`.

## Skill-registry ringan

- Registry di `packages/agent/src/registry.ts`: `[{name, description, evidenceSources, featureFlag, promptBuilder}]`. Flag `--with dividend risk` filter registry, bukan Cordis `preset` YAML. Tanpa flag → prompt tidak mengandung section terkait (mis. `dividendYield`).

## Degradasi & fail-closed (reuse §24-A.5 / §24-B.3)

- Enrichment Phase 2 (streaming, export) gagal → `UserFriendlyError` + run tetap `completed`; tidak mengubah `executions.status`.
- Jaminan integritas (validasi Layer 2/3) gagal eksekusi → `failed` (`VALIDATION_UNAVAILABLE`), bukan silent-lolos — sama dengan Phase 1 `rules.md:28`.

## Pengujian (TDD)

- Tulis/update test **bersama** perubahan (konvensi `AGENTS.md`). Mock deterministik `--mock-sectors --mock-llm` harus bisa buktikan `listRuns`, `export md` berisi `BBCA · FINAL JUDGMENT`, streaming `onChunk` 3×, tanpa API key.
- `pnpm check` (typecheck + vitest unit + E2E spawn CLI) harus hijau sebelum commit — gate Phase 2 (`tasklist.md:Gate`).
