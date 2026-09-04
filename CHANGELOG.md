# Changelog

Semua perubahan terdokumentasi — sumber `git log --oneline` + `ARCHITECTURE.md` Deviasi.

## 0.3.0 — 2026-09-04 (Phase 8 · Release & Distribution)

- **Release hardening:** `.github/workflows/ci.yml` (`pnpm check` Node 22), `CHANGELOG.md`, README polish `v0.3.0` + slash commands lengkap Phase 7 (`/search`), bump version `0.2.0→0.3.0` (Deviasi #29).

## 0.2.0 — 2026-09-03 (Phase 6 · Final RC)

- **Final RC:** evaluasi agregat Phase 0→6 vs addendum §04–§29 (`progress/phase-6/eval.md`), bump `0.2.0-rc→0.2.0`, gate `203/203` (Deviasi #27).

## 0.2.0-rc — 2026-09-03 (Phase 5 · Version + Metrics)

- **Version & metrics:** `VERSION` dinamis dari `package.json` + `/version` & `--version`, banner `v${VERSION}`, `formatDuration` + `/history` kolom `Time`, `renderHelp` lengkap (`history/session/resume/web/export/version`), `metrics.test.ts` (Deviasi #26).

## 0.2.x — Phase 4 (Session UX + Web Preview)

- `/history`/`/session`/`/resume` (reuse `listRuns`/`getExecutionWithArtifacts`), `/web` tiny `node:http` (`GET /` + `/api/history` + `/api/run/:id`, port 3280), `conditionalUsed` badge (Deviasi #25). — `197/197`.

## 0.2.x — Phase 3 (Orchestration)

- **LangGraph evaluated → not adopted** (minimal `Workflow` 50-baris linear+branch), conditional debate `--conditional` (neutral/40–60, seq 5–7, upsert `judgments`), `where` SQL-native `buildWhereClause` + fallback (Deviasi #22–#24). — `191/191`.

## 0.1.x — Phase 2 (Advanced Features)

- Session helpers `listRuns`/`getExecutionWithArtifacts` reuse `toEvidence`, `streamText` dua jalur + Agent-Events JSONL, `export` md/html, skill-registry `--with`, replay fixture `bbca.jsonl` — `177/177` (Deviasi #19–#21).

## 0.1.0 — Phase 1 (Market & News + Debate ronde)

- Debate ronde Bear+Bull rebuttal (run-scoped `validateChallenge`, `assertSeenEvidence`), Market & News Researcher (§24-A: `DailyTransaction`/`ForeignFlow`/`News`/`Filings`/`Sentiment` mock), Sectors v2 `/v2` base, `where` → `where` native deferred. — `150/150→177`.

## 0.1.0 — Phase 0 (Foundation)

- REPL + Evidence-First (Researcher→Bull→Judge), `EvidenceStore` dedup `content_hash`, `ConversationStore`, `ExecutionStore`, 3-layer `ClaimValidator`, `SectorsClient` + file cache, `LLMClient` dua-tier + `MockLLMClient`, rubrik 5 kategori renormalisasi.
