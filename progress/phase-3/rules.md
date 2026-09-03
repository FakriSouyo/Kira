# Rules — Phase 3 (Orchestration + Where)

Konvensi khusus Phase 3 yang **belum** tercakup di `AGENTS.md` / `ARCHITECTURE.md`.
Aturan global tetap di `AGENTS.md`; dokumen ini hanya delta.

## Workflow abstraction

- `WorkflowBuilder` **tidak** menggantikan hardcode — hanya pembungkus linear `step(name, fn)` + `branch(predicate, thenBranch)`. Tidak ada dependency baru (bukan LangGraph).
- Workflow tetap **fail-closed** (§24-B.3): langkah validasi gagal eksekusi → `failed`, bukan silent-lolos.

## Conditional debate

- Trigger: `judgment.stance === 'neutral'` **atau** `40 <= score <= 60` — satu ronde ekstra saja (Bear2 → Bull2 → Judge2). `sequence_order` 5–6, `judgment` overwrite (UNIQUE run_id).
- Opt-in via `judgeWorkflow(ctx, ticker, progress, events, { conditional: true })` atau `/judge BBCA --conditional`. Default `false` untuk hemat token.

## Screener where SQL

- `buildWhereClause(criteria: string[]) → string | null` mapping: `profitable → roe>0`, `growing → revenue_growth>0`. Kriteria tak dikenal → `null` (fallback client-side scoring `computeMatchScore`).
- URL: `GET /companies/?where=<encoded>&limit=200`. Jika `where` 400/500 → fallback tanpa `where` + scoring lokal (jangan fail run).

## Pengujian (TDD)

- Tulis/update test **bersama** perubahan. Mock deterministik `--mock-sectors --mock-llm` harus bisa buktikan conditional trigger & where URL tanpa API key.
- `pnpm check` hijau sebelum commit.
