# Eval — Agregat Phase 0→6 vs addendum_v3.0.md (§04–§29)

> Evaluasi **sebelum** melanjutkan — Phase 2→3→4→5 masing-masing dievaluasi via `pnpm check` hijau; di sini agregat final sebelum release `0.2.0`.

## Ringkas tiap Phase (evaluated)

| Phase | Scope (addendum) | Status evaluasi | Gate `pnpm check` | Deviasi penutup |
|-------|------------------|-----------------|-------------------|-----------------|
| **0** | REPL + Evidence-First (3-agent flow, 5-kategori rubrik, dua-tier routing) | ✅ OKE — base pure interfaces, EvidenceStore dedup, Judge renormalisasi 65 | 100+ hijau (historis) | #1–#13 locked |
| **1** | Debate ronde + Market/News Researcher (§24-A) | ✅ OKE — Bear+rebuttal + Market/News enrichment, degradasi null, Mock deterministik | 137→150 hijau `8a83768` | #14, #16, #17 tertutup v2 |
| **2** | Advanced Features (session, streaming, export, skill-registry, replay) | ✅ OKE — `listRuns`/`getExecutionWithArtifacts`, `streamText` dua jalur, `export md/html`, registry `--with`, fixture `bbca.jsonl` | **177/177** (24 files) `d096f12` | #19–#21 |
| **3** | Orchestration Upgrade (LangGraph eval, conditional débat, where screener) | ✅ OKE — evaluasi LangGraph **tidak adopsi** (minimal abstraction), `Workflow` 50-baris, conditional `neutral/40–60` (seq 5–7, upsert), `where` SQL-native `roe/yoy_quarter_revenue_growth` + fallback | **191/191** (27 files) `25cb66e` | #22–#24, #14b/#18 tertutup |
| **4** | Session UX + Web Preview (GUI Vision Bridge §28) | ✅ OKE — `/history`/`/session`/`/resume` (reuse artifacts), `web.ts` `node:http` (GET / + /api/history + /api/run/:id, port 3280), `conditionalUsed` badge | **197/197** (29 files) `22b779f` | #25 |
| **5** | Polish, Metrics & Release Prep (§29 deployment) | ✅ OKE — `VERSION` dinamis `0.2.0-rc`, `/version` + `--version`, `formatDuration` + `/history` Time, `renderHelp` lengkap | **203/203** (31 files) `5c9d09c` | #26 |
| **6** | Final RC (penguncian) | ✅ OKE — evaluasi agregat ini, bump `0.2.0`, docs final, smoke | **203/203** (gate) | — (stop di 6) |

## Kepatuhan addendum kunci (§04–§29)

- **§04 Prinsip terkunci:** agent pure, DB hanya `database`, `shared` canonical, ESM-only, pnpm strict — **dipatuhi semua phase**.
- **§05–§13 Data layer:** EvidenceStore `content_hash` dedup, `agent_messages` `sequence_order`, `breakdown` 5 kategori (momentum/risk null Phase 0) — **dipatuhi**.
- **§14–§16 Agent flow:** 3-agent Phase 0 → Debate ronde Phase 1 (Bull→Bear→Bull→Judge) + Market/News — **dipatuhi**; Phase 3 conditional adalah ronde 2 opt-in (addendum §27).
- **§17 LLM:** dua-tier + `maxTokens` + `streamText` dua jalur (Deviasi #21) — **dipatuhi**.
- **§18–§21 REPL/UX:** `/judge`, `/screen`, `/history`, `/session`, `/export`, `/web`, `/version` — **dipatuhi**; Phase 4 web preview bridge §28 (tanpa Tauri).
- **§22–§29 Roadmap:** Phase 3 orchestration (LangGraph dievaluasi, tidak adopsi), Phase 4 GUI bridge, Phase 5 deployment prep, Phase 6 RC — **dipatuhi; Phase 7 (pgvector/turnar penuh) deferred Future**.

## Gate sebelum commit Phase 6

- `pnpm typecheck` ✅ 0 error
- `pnpm test` ✅ **203/203** (31 files) — E2E spawn CLI asli mock sukses
- `--version` ✅ cetak versi `0.2.0`
- Tidak ada migrasi DB baru sejak Phase 2 — satu-satunya `schema.ts` tahu snake↔camel

## Keputusan stop

Berhenti di **Phase 6** — cukup sebagai Release Candidate `0.2.0`. Phase 7 (pgvector Future, Tauri penuh, worker-thread cancel asli) ditunda hingga ada consumer — sesuai `AGENTS.md` "foundation over blast radius" dan `planning/phase-6.md` §1.

> Next: bump `0.2.0-rc → 0.2.0`, commit, tag release (opsional).
