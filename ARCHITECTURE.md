# ARCHITECTURE — Financial Agent Harness (Phase 0 + Debate ronde Phase 1)

Dokumen teknis: bagaimana sistem dibangun, keputusan desain yang diambil, dan
deviasi terdokumentasi dari addendum v3.1.

## 1. Layer & Abstraksi (Locked)

```
apps/cli (REPL + commands + workflows)          ← satu-satunya UI
        │
packages/agent (Bull, Bear, Judge, Router)      ← pure functions, tanpa DB write
        │
packages/llm (LLMClient / MockLLMClient)        ← LLMClientLike interface
        │
packages/sectors-api (SectorsClient / Mock)     ← SectorsApi interface
        │
packages/execution (validator + store interfaces)
packages/evidence, packages/conversation (store interfaces)
packages/schemas (Zod) · packages/shared (utils)
        │
packages/database (*Sqlite)                     ← SATU-SATUNYA yang menyentuh Drizzle
```

Prinsip terkunci (addendum §04): **agent adalah pure function** — membaca evidence
read-only, mengembalikan respons terstruktur; **workflow** (apps/cli) yang
mem-persist ke DB. Konsekuensinya agent dapat diuji tanpa database sama sekali
(lih. `packages/agent/test/fakes.ts`).

## 2. Evidence-First Flow (/judge, termasuk Debate ronde Phase 1)

1. **Researcher** (bukan LLM): fetch `company_report` + `quarterly_financials`
   → simpan ke Evidence Store dengan dedup content-hash (SHA-256 canonical JSON).
2. **Bull** (`claim`): system prompt 2 zona → `generateObject` (Zod) → reasoning + klaim.
3. **Validasi 3 lapis** (`ClaimValidator`):
   - Layer 1: struktur (Zod — `evidenceIds` non-kosong, uuid valid)
   - Layer 2: evidence ID ada di DB (anti-hallucination)
   - Layer 3: evidence termasuk allowed set run ini (anti cross-run contamination)
4. **Bear** (`challenge`): klaim Bull + evidence → `generateObject` →
   counterpoints (`targetClaimId` + `argument` + `strength`). Validasi
   run-scoped (`validateChallenge`): `targetClaimId` harus klaim milik run ini
   dan `evidenceIds` Bear harus ada di DB + dalam allowed set.
5. **Bull rebuttal** (`response`): counterpoints Bear → `generateObject` →
   reasoning + klaim pertahanan (klaim tervalidasi 3 lapis seperti pada langkah 3).
6. **Judge**: semua klaim (Bull + rebuttal) + conversation penuh →
   `generateObject` → judgment rubrik 5 kategori.
7. Persist: `executions` (state machine running→completed/failed), `agent_messages`
   (sequence_order 0–4), `claims`, `judgments` — audit trail penuh per `run_id`.

## 3. Prompt & Token/Cache Strategy (addendum §17)

System prompt = 2 zona:

- **Zona [1]**: preamble + evidence block (`renderEvidenceBlock`) — key JSON
  di-sort rekursif (`sortKeys`) sehingga blok **byte-identical** antar agent
  dalam satu run. Dilarang data volatil (timestamp, ID acak) di zona ini.
- **Zona [2]**: persona & instruksi spesifik agent.

Prefix (zona [1] + pemisah) yang identik memanfaatkan **automatic prefix caching**
OpenAI. LLMClient menggabungkan zona menjadi satu string (lihat Deviasi #1).

`maxTokens` terkunci per tier: agent 2000 (t0.2), router 256 (t0.0) — kontrol biaya.

## 4. Skor Judge — Penegakan Deterministik

LLM hanya menghasilkan breakdown 5 kategori; **skor keseluruhan dihitung ulang
oleh kode** (`normalizeJudgmentScore`, `packages/shared/src/rubric.ts`):

```
score = round( Σ wᵢ·sᵢ / Σ wᵢ )   atas kategori non-null saja
momentum & risk = null selama data market belum di-fetch
→ bobot 25/20/20 direnormalisasi atas 65
```

Stance juga dipaksa align: `>60 bullish, <40 bearish, selainnya neutral`.
Aritmetika LLM tidak dapat diaudit; rumus rubrik bersifat non-negotiable.

## 5. Mock Mode (Development Offline)

- `--mock-sectors`: `MockSectorsApi` menyajikan fixture 5 bank (BBCA, BBRI, BMRI,
  BBNI, BJTM) dengan data konsisten; ticker tak dikenal melempar `NOT_FOUND`
  persis seperti client asli (jalur error tetap teruji).
- `--mock-llm`: `MockLLMClient` deterministik — **bukan template kosong**:
  - Router: regex intent (ticker IDX 4-huruf, kata kunci beli/tumbuh/overvalued/vs)
  - Bull: **membaca evidence block dari zona [1]** dan membangun klaim dari angka
    riil (ROE, growth YoY) dengan confidence berbasis threshold; bila prompt
    berisi marker debat ("Bear Agent raised the following challenges") → mode
    rebuttal dengan claim id `rebuttal_N`
  - Bear: menarget klaim Bull yang tercantum di prompt (id dibaca dari baris
    `(claim: <id>, Confidence: ...)`) dan membangun argumentasi dari angka
    evidence dengan strength berbasis threshold
  - Judge: menghitung jumlah klaim per confidence dari prompt, skor via rubrik;
    bila conversation berisi `BEAR (challenge)` → summary menyebut debate ronde
    dan confidence turun ke `moderate`
  - Output selalu divalidasi dengan Zod schema pemanggil — mock yang menyimpang
    membuat test gagal, bukan silent.

Kombinasi kedua flag menjalankan seluruh pipeline E2E offline — dipakai oleh
`apps/cli/test/e2e.test.ts` (spawn proses CLI asli, verifikasi output + state DB).

## 6. Caching (addendum §13)

| Level | Lokasi | TTL |
|---|---|---|
| Evidence | SQLite `evidence` (dedup content-hash, persisten) | permanen |
| Sectors API | file `<home>/cache/sectors_api/*.json` | 24 jam (config) |
| LLM prompt | sisi provider (prefix caching) | sesuai provider |

Screener tidak di-cache (kriteria bervariasi per panggilan). File cache ditulis
atomik (tmp + rename), key di-sanitize, file korup = cache miss.

## 7. Error Handling (addendum §21)

Semua error di-map ke `UserFriendlyError { code, message, suggestion }` sebelum
mencapai terminal: `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMIT`, `TIMEOUT`,
`SERVER_ERROR`, `NETWORK` (Sectors), `EVIDENCE_HALLUCINATION` (validasi —
termasuk challenge Bear yang menarget claim/evidence asing), `INVALID_TICKER`,
`MISSING_TICKER`, `VALIDATION_UNAVAILABLE` (gagal **mengeksekusi** validasi → fail
run, lihat §24-B.3), `NEWS_UNAVAILABLE` (kegagalan researcher news → enrichment
degrade, lihat §24-A.5), `UNKNOWN_ERROR`.
Run yang gagal tetap tercatat di `executions` dengan status `failed`.

## 8. Deviations dari Addendum (terdokumentasi)

| # | Addendum | Implementasi | Alasan |
|---|---|---|---|
| 1 | Anthropic breakpoint `cache_control` eksplisit di akhir zona [1] | Zona tetap byte-identical, tetapi digabung jadi satu string system prompt | AI SDK 5.0.250 (versi yang terpasang) men-tipekan `system` sebagai `string` saja — per-part `providerOptions` tidak tersedia. Zona [1] byte-identical tetap aktif; breakpoint menyusul saat upgrade AI SDK. |
| 2 | `renderEvidenceBlock` di `shared/prompt.ts` memakai `JSON.stringify(sortKeys)` pretty | Sama persis (pretty 2-spasi) | Sesuai. `sortKeys`/`canonicalJson` dipindah ke `@harness/shared` (dipakai prompt & dedup), `@harness/evidence` me-re-export agar API lama utuh. |
| 3 | Endpoint Sectors API (kontrak HTTP) | Terpusat di `packages/sectors-api/src/client.ts` (base URL configurable) | Kontrak API riil belum tersedia; mock mode jadi jalur development. Saat API riil tersedia, hanya file client yang disentuh. |
| 4 | Retry LLM: `generateWithRetry` di LLMClient | LLMClient retry error ber-`code` retryable (`RATE_LIMIT`/`TIMEOUT`/`SERVER_ERROR`) dengan backoff eksponensial | AI SDK sudah mem-retry `APICallError` 429/5xx secara internal (dengan Retry-After) — lapisan LLMClient adalah defense-in-depth untuk error yang dibungkus, bukan duplikat backoff. |
| 5 | — | Skor & stance judgment dihitung ulang deterministik di `JudgeAgent` | Aritmetika LLM tidak dapat diaudit; rubrik §15 non-negotiable. |
| 6 | `pnpm finharness` membuka REPL | Sesuai, ditambah `--mock-sectors` / `--mock-llm` / `--home` | Mock LLM dibutuhkan agar E2E & demo offline deterministik tanpa API key. |
| 7 | Hints `/evidence`, `/export` di contoh output §19 | Tidak ditampilkan (command belum ada di scope Phase 0) | Core commands Phase 0 = /judge, /screen, /help, /exit + stubs; hint ke command yang tidak ada menyesatkan. |
| 8 | Ctrl+C saat executing = "cancel immediately" | Best-effort: notifikasi + berhenti di batas fase berikutnya | Node tidak dapat mem-batalkan fetch/AI SDK call yang sedang berjalan; batas fase (researcher→bull→judge) adalah titik cancel yang aman. |
| 9 | §17 dua-tier LLM hanya menyebut provider OpenAI/Anthropic default | Ditambah `baseURL`/`apiKey` per tier (env `LLM_BASE_URL`/`LLM_API_KEY` global, atau `base_url`/`api_key` per-tier di config.json) — mendukung endpoint OpenAI-compatible apa pun (DeepSeek, OpenRouter, Ollama lokal) | Ekstensi, bukan konflik: default tetap OpenAI/Anthropic bila field kosong. **Keputusan krusial:** `resolveModel` selalu memakai `provider.chat(model)` (chat completions) — call default provider OpenAI memakai Responses API yang hanya ada di OpenAI asli dan akan gagal di endpoint kustom. Teruji dengan fake server OpenAI-compatible (wire-level) di `packages/llm/test/client.test.ts`. |
| 10 | §15 prompt challenge Bear tidak menampilkan id klaim Bull | Prompt challenge mencantumkan id di tiap baris klaim: `(claim: <claimId>, Confidence: <c>)` | Skema Bear menuntut `targetClaimId` yang valid — id harus terlihat oleh LLM. Tervalidasi run-scoped oleh `ClaimValidator.validateChallenge`. |
| 11 | §15 tidak mengatur id klaim pada rebuttal Bull | Klaim rebuttal dinormalisasi workflow menjadi `rebuttal_1..n` sebelum persist | `UNIQUE(run_id, claim_id)` — id LLM bebas bisa bentrok dengan klaim asli; normalisasi juga menandai asal claim di audit trail. |
| 12 | §27 Roadmap: Phase 1 = "Bear Agent + Bull rebuttal, Market Researcher, News Researcher" | Debate ronde (Bear + rebuttal) selesai; **Market & News Researcher terspesifikasi** di addendum §24-A | Addendum v3.1 hanya memberi nama domain data (Daily Transaction, Foreign Flow / News, Filings, Sentiment). Kontrak endpoint, skema evidence, dan desain agent kini dikunci di `addendum_v3.0.md` §24-A — implementasi berjalan langsung di atas kode Phase 0 + Debate ronde tanpa migrasi schema DB. |
| 13 | — (pola baru, bukan deviasi addendum) | **Tiga pola disiplin diadopsi** sebagai invariant: §24-B (1) "yang dilihat = yang dicatat" — `agent_messages.metadata.seenEvidenceIds` byte-identical dengan evidence block zona [1] + assertion `claim.evidenceIds ⊆ seenEvidenceIds` (bukan warning); (2) replay fixture keyless utk integration/E2E (Task 19) sbg pelengkap mock generatif; (3) **fail-closed** utk jaminan integritas (gagal *mengeksekusi* validasi → run `failed`, bukan silent-lolos), sedangkan enrichment Market/News tetap silent-degrade (§24-A.5) | Diadaptasi dari pola `deepseek-harness/` tanpa dependency baru; tidak menyalin kode DSH. Rincian di `addendum_v3.0.md` §24-B. |
| 14 | §24-A.2 kontrak endpoint Market/News (path logis vs riil) | **Tercapai/tertutup setelah migrasi v1→v2**: v1 API *discontinued* (HTTP 410 sejak 2026-05-11). Client kini memakai **v2**: base URL `/v2`, auth `Authorization: <key>` **tanpa** prefix Bearer (Bearer → 401), dan jalur: `/company/report/{s}/`, `/financials/quarterly/{s}/` (array), `/daily/{s}/` (array), `/foreign-flow/{s}/` (`{data:[{net_foreign_inflow}]}`), `/news/?symbols=` (`{results}`), `/filings/?symbol=` (`{results}`), `/companies/` (screener). Kontrak diverifikasi terhadap `docs.sectors.app` + panggilan live. Transpormasi v2→canonical terpusat di `client.ts` agar konsumen (agent opaque) tak berubah. |
| 14b | Screener `roe` di v2 (`/companies/`) | `roe` tidak diekspos `companies` v2 → `ScreenerRow.roe = undefined` (`client.ts:280`), `computeMatchScore:56` `profitable` selalu 0 di real (hanya `growing` aktif). Mock tetap pakai `roe` fixture agar demo `/screen profitable` deterministik. | Low untuk CLI demo; `where=roe>0` sudah dikirim (Task 3) — server memfilter, walau `roe` tetap undefined di row (skor profitable tetap 0 client-side; filter server-side yang berlaku). |
| 18 | Screener `where` SQL v2 belum dipetakan | `SectorsClient.screen` pakai `GET /companies/?limit=200` + `computeMatchScore` client-side atas `{results}` (deterministik, sesuai `where` mock). `?criteria=` kanonik tidak dikirim; `?where=` SQL-native belum dipakai. | **TERTUTUP 2026-09-03 Phase 3 Task 3**: `buildWhereClause` + `screen` kini kirim `?where=` (`roe>0`, `yoy_quarter_revenue_growth>0`) encode, fallback 400→tanpa where. `ScreenerRow.roe` tetap undefined — skor client-side tidak bergantung `where`. |
| 16 | §24-A.4 News Researcher "Sentiment" (endpoint v2 tak ada) | `getSentiment` menjadi **turunan**: dari `company_report.overview.tags` + sign foreign-flow (keputusan: tanpa panggilan berbiaya tambahan; news & foreign sudah di-fetch). Filings/news pakai envelope `{results}`; `sectors.sentiment` source evidence tetap dipertahankan dari hasil turunan | v2 tidak punya endpoint sentimen agregat. Konsisten dgn desain opaque evidence; mock LLM membaca `aggregate`/`distribution.negative` dari data evidence yang tetap sama bentuknya. |
| 17 | §24-A.3 Quarterly Financials & growth (v2) | v2 `/financials/quarterly/{s}/` hanya mengembalikan **satu kuartal** per panggilan (perlu `report_date` untuk kuartal lain). **TERTUTUP 2026-09-03**: `SectorsClient.getQuarterlyFinancials` kini mengisi `revenueGrowthYoy`/`netIncomeGrowthYoy` yang kosong dari `company_report.financials.yoy_quarter_*_growth` (pct, report sudah di-fetch & cached — `getCompanyReport` hit cache). Rubrik growth 20% kini berjalan dengan data asli; `CompanyReport.financials` diperluas `yoyQuarterRevenueGrowth`/`yoyQuarterEarningsGrowth`; fixture mock diselaraskan. | Menghindari N-call per run; kalau `report` tidak tersedia, tetap `undefined` (rubrik renorm). |
| 15 | §12 kebijakan "env + credential file, tidak pernah materialize ke proses" (Referensi DSH) | Sekadar catatan kebijakan → **diwujudkan**: `loadConfig` kini membaca `.credentials.json` opsional (`~/.finharness/.credentials.json`) dengan prioritas key **env → `.credentials.json` → config.json (legacy) → default**; `config.json` difokuskan ke non-secret | Key mentah dijauhkan dari `config.json` agar isi config aman dibagikan/di-screenshot. `sectors_api.key` / `llm.*.api_key` di `config.json` dipertahankan sebagai fallback backward-compat (test lama tetap lulus). Prioritas: env > credential file > config legacy. |
| 19 | Phase 2 Task 1 — session helper & pemetaan read-back | `listRuns` + `getExecutionWithArtifacts` di `executionStoreSqlite.ts` memetakan ulang baris **manual inline** (`sourceType`/`JSON.parse` per kolom), bukan memanggil helper existing `toEvidence(row)`. Ini menduplikasi pemetaan snake→camel di luar `schema.ts` (melawan kutipan AGENTS.md "pemetaan eksplisit hanya di schema.ts"). **TERTUTUP 2026-09-03**: `toEvidence`/`EvidenceRow` kini di-`export` dari `evidenceStoreSqlite.ts` dan `getExecutionWithArtifacts` reuse `toEvidence` (bukti konsistensi: test `session.test.ts` `getExecutionWithArtifacts().evidence toEqual getByRun()`). | Refactor hanya menyentuh pemetaan evidence; behavior tak berubah, `pnpm check` tetap hijau (150+ test). |
| 20 | ORDER deviasi | Tabel Deviations kini tidak kontigu (12,13,14,**14b,18,16,17**,15,19). | Kosmetik; urutan semantik (migrasi → deviasi v2 → phase-2) lebih penting daripada nomor kontigu. Biarkan. |
| 21 | Phase 2 Task 2 — streamText dua jalur + Agent-Events JSONL | `generateObject` tetap untuk klaim/judgment (zona [1] byte-identical, cache prefix). `LLMClient.streamText` (Vercel `streamText → textStream`) adalah **jalur kedua** hanya untuk narasi/REPL `message.delta`; sengaja **tanpa `withRetry`** (stream tak bisa di-retry tengah jalan). Konsumsi: `for await (const c of client.streamText(...))`. `Agent-Events` di `apps/cli/src/repl/events.ts` (`session/phase/tool/evidence/message.delta`) dipicu `judgeWorkflow(…, events)` default no-op → **E2E tak berubah** (events opt-in, dipanggil hanya bila sink diberikan, dibuktikan `workflow-events.test.ts`). | Mock `MockLLMClient.streamText` yield 3 chunk deterministik; `FakeLLM` di `packages/agent/test/fakes.ts` dilengkapi stub `streamText`. |
| 22 | Phase 3 Task 1 — LangGraph vs hardcode | Addendum §27 Phase 3: evaluate LangGraph, conditional workflows. **Dievaluasi: tidak adopsi LangGraph** — premature abstraction untuk 2 workflow (AGENTS.md minimal abstraction). Gantikan dengan `Workflow` 50-baris linear + conditional branch di `apps/cli/src/workflows/workflow.ts` (step/branch/run, fail-closed). | Tidak ada dependency baru; `judgeWorkflow` tetap hardcode, `Workflow` hanya dipakai untuk dokumentasi/orchestration ringan; `pnpm check` 191/191. |
| 23 | Phase 3 Task 2 — Conditional debate + judgment upsert | `judgeWorkflow(…, {conditional})` → extra Bear2 (seq5) + Bull2 (seq6) + Judge2 (seq7) bila `stance neutral` atau `40<=score<=60`; `judgments` `UNIQUE(run_id)` kini **upsert** (`onConflictDoUpdate`) agar overwrite sah untuk conditional. | `conditional.test.ts` 3 tests. Deviasi #23 menutup test "UNIQUE throw" lama → kini `upsert overwrite`. |
| 24 | Phase 3 Task 3 — Where SQL-native | `buildWhereClause` mapping `profitable→roe>0`, `growing→yoy_quarter_revenue_growth>0`, `screen` kirim `?where=` encode + fallback 400→tanpa where. | Menutup #14b/#18; `where.test.ts` 6 tests, `pnpm check` 191/191. |
| 25 | Phase 4 — Session UX + Web preview | `/history [--limit]` (listRuns), `/session <runId>` (getExecutionWithArtifacts→markdown), `/resume` alias, `/web [--port]` tiny `node:http` server (GET / + /api/history + /api/run/:id), `JudgeArtifacts.conditionalUsed` badge di renderer. | `/web` tidak auto-start, default 3280 (hindari DSH 3080); `history.test.ts` (3) + `web.test.ts` (3), `pnpm check` 197/197. |
| 26 | Phase 5 — Version + Metrics | `package.json` `0.1.0→0.2.0-rc`, `VERSION` dari `package.json` + `/version` command, `--version` CLI flag, `formatDuration` + `/history` `Time Xs`, `renderHelp` lengkap (history/session/resume/web/export/version). | Fallback `0.1.0` bila file tak ada; `version.test.ts` (3) + `metrics.test.ts` (3), `pnpm check` 203/203. |
| 27 | Phase 6 — Final RC | `0.2.0-rc→0.2.0` + `eval.md` agregat 0→6 vs addendum §04–§29, gate final. **Stop di Phase 6** (Phase 7 pgvector/Tauri deferred Future). | `eval.md` + `pnpm check` 203/203, `--version` → `0.2.0`. |
| 28 | Phase 7 — Future Vector Prototype (lanjutan `lanjut`) | `vector.ts` `mockEmbedding` 8-dim + `cosineSimilarity`, `search.ts` `searchEvidence` (keywordOverlap + cosine), `/search <query> [--run --limit]` + `renderSearchResult`, normalized vision DDL docs only (tanpa migrasi/pgvector real). | Mock placeholder pgvector Future; `vector.test.ts` (4) + `search.test.ts` (4), `pnpm check` **211/211**. |
| 29 | Phase 8 — Release & Distribution (lanjutan) | `.github/workflows/ci.yml` (`pnpm check` Node22), `CHANGELOG.md` Phase0→8, `README.md` polish badge `v0.3.0` + commands lengkap, bump `0.2.0→0.3.0`. | Hardening pasca-Future; `pnpm check` tetap **211/211**. |
| 30 | Phase 9A — Real Future (lanjutan 9A) | `0002_normalized.sql` real migration + `schema.ts` `financials_normalized`/`daily_normalized` + `NormalizedStore` upsert, `vector.ts` `getEmbedding` (LLM→fallback mock), `Workflow.run({signal})` + `judgeWorkflow({signal})` abort check. | Real minimal offline-safe; `normalized.test.ts` (4) + `abort.test.ts` (4), `pnpm check` **219/219** (35 files). |

## 9. Struktur Data (ringkas)

- `executions`: state machine `running → completed|failed` (transisi ganda dilarang)
- `evidence`: `UNIQUE(content_hash)` — dedup lintas run; `data` = JSON TEXT
- `agent_messages`: `UNIQUE(run_id, message_id)`, urut `sequence_order`
- `claims`: `UNIQUE(run_id, claim_id)`
- `judgments`: `UNIQUE(run_id)`, `breakdown` JSON TEXT (5 kategori)

Konvensi: **snake_case di DB ↔ camelCase di TS/Zod**, dipetakan eksplisit di
`packages/database/src/schema.ts` (satu-satunya tempat yang tahu dua konvensi).

### Canonical lifecycle foundation (PR A)

`ResearchSessionStore` adalah persistence boundary untuk relasi durable
`Session -> Turn -> Execution`, bukan pemilik workflow, context, artifact,
journal projection, cache, atau memory. Setiap input yang diterima akan menjadi
satu Turn setelah wiring production di PR B; Turn dapat memiliki nol atau banyak
Execution attempt.

Migrasi `0007_canonical_lifecycle.sql` mempertahankan `research_turns.run_id`
sebagai kolom transisi nullable tanpa constraint unik, lalu memindahkan ownership
ke `executions.session_id`, `executions.turn_id`, dan `executions.attempt`. Relasi
lama di-backfill sebagai attempt 1. Execution lama tanpa research turn tetap
valid dan tidak dipaksa memiliki relasi palsu. Status terminal execution canonical
mencakup `completed`, `failed`, dan `cancelled`.

### Live lifecycle and journal linkage (PR B)

`createHarnessSession` adalah composition boundary untuk request live. Setiap
input yang diterima membuat tepat satu Turn melalui `ResearchSessionStore`, lalu
menyelesaikannya sebagai `completed`, `failed`, atau `stopped`. Percakapan biasa
tidak membuat Execution. `/judge` membuat Execution canonical untuk Turn yang
sama, tetapi tetap menjalankan pipeline manual yang ada; pemindahan execution
truth ke `WorkflowRunner` dikerjakan di PR C (selesai — Deviation #33).

Command yang presentasinya ditangani lokal oleh workspace TTY (`/help`, menu,
`/context`, dan `/new`) tetap melewati boundary lifecycle yang sama; UI tidak
boleh membuat jalur input kedua. Saat restart, proyeksi journal yang masih
`running` direkonsiliasi terhadap lifecycle canonical: status terminal canonical
diproyeksikan apa adanya, sedangkan Execution yang sungguh terputus diselesaikan
`cancelled` dan Turn induknya diselesaikan secara konsisten.

`ConversationJournal` hanya menyimpan audit/replay append-only. Event baru
memakai payload version 1 dan membawa `turnId`, `executionId` bila ada,
`correlationId`, serta rantai `causationId`; `sessionId`, sequence, dan timestamp
tetap berada pada envelope journal. Event lama tanpa metadata itu tetap dapat
dibaca. Pembuatan Session tidak lagi dimiliki journal.

### SessionWorkingContext (PR D)

Working context adalah materialized view **versioned** dari "apa yang masih
relevan di satu session" — reference state terstruktur, bukan history. Journal
tetap pemilik urutan kejadian; `SessionWorkingContext` hanya memiliki yang masih
relevan. Contract: `packages/session/core/src/workingContext.ts`
(`applyWorkingContextPatch` murni, `assertWorkingContextCommit` untuk CAS,
`deriveWorkingContextPatch` hanya dari baris durable). Storage:
`session_context_versions` (migrasi `0008`) + `WorkingContextStoreSqlite`
(`current`/`at`/`history`/`commit`); versi lama tetap terbaca dan tidak ada pointer
"current" terpisah, sehingga tidak ada state turunan yang bisa drift.

Updater tunggal ada di `apps/cli/src/repl/workingContext.ts`, dipanggil dari
composition boundary setelah Turn settle `completed`:

```text
/judge BBRI         → activeSubjects=[BBRI], currentIntent=judge,
                      activeVerdictRef={kind:'judgment', executionId} (resolve via judgments.getByRun)
kenapa BBRI turun?  → currentIntent=conversation (Turn tanpa Execution; subject tetap)
Turn failed/stopped → tidak publish apa pun
```

Dua guard compare-and-set menolak penulis stale: `expectedVersion` lama
(`STALE_CONTEXT_VERSION`) dan prefix journal lama (`STALE_SOURCE_SEQUENCE`).
`sourceSequence` adalah sequence kanonik `turn.started` milik Turn yang diterima,
bukan journal tail saat settlement, sehingga completion Turn lama tidak dapat
terlihat causally lebih baru hanya karena selesai belakangan.
Journal menerima satu event referensi `session.context.updated` per versi; payload
context tidak diduplikasi ke journal, dan kegagalan append tidak membatalkan versi
durable (diperbaiki deterministik saat restore). Field yang belum punya produsen
durable (thesis/bull/bear/risk ref, focus topics, pinned refs, user assertion,
summary ref) dibiarkan kosong — bukan diarang; PR F/G yang mengisinya. PR E
(freshness/reuse provider) sengaja tidak ada di sini: working context hanya
mereferensikan, tidak pernah mengotorisasi reuse data eksternal.

### ContextPacket (PR G)

`@harness/context` projects the captured `SessionWorkingContext` into one
immutable, invocation-scoped `ContextPacket`; it is not journal history or a
provider-cache payload. PR L adds bounded same-session Artifact Retrieval by
exact subject and existing artifact kind, followed by structural validity
checks against the completed source Execution. The Reference Resolver resolves
explicit active/pinned refs plus retrieved candidates, the deterministic
Context Policy selects eligible candidates, and the Context Assembler emits
stable thesis/Bull/Bear/Verdict/pinned/retrieved ordering with artifact-ID
deduplication and provenance. Retrieved artifacts are prior context only when
freshness is unknown; provider freshness remains PR E's authority. PR L does
not memoize workflow outputs, expand Evidence, call providers/models, mutate
working context, or search across sessions. Bull/Bear/Judge remain `/judge`-
scoped specialists and receive current-Execution context only.

### ContextSnapshot (PR H)

`ContextSnapshot` is the immutable durable record of the exact structured
`ContextPacket` used for one invocation. Its canonical SHA-256 fingerprint
excludes only operational creation time; packet trust distinctions, provenance,
source refs, selected artifact IDs, diagnostics, and stable ordering are
preserved. `ModelCall.contextSnapshotId` is nullable for existing/transitional
calls that did not consume a ContextPacket; explicitly supplied context cannot
silently degrade to a null link. PR H does not inject context into agents,
render prompts, count tokens, or change provider behavior.

### Rencana PR berikutnya (Core Refactor Plan)

Urutan PR dan definisinya yang mengikat ada di `docs/core/03-CONTEXT-AND-MEMORY.md`
§21 (PR A–PR L) dan `docs/core/13-CORE-REFACTOR-PLAN.md` §8. PR A–PR G selesai;
**PR E = selective provider retrieval + freshness policy** disisipkan setelah PR D
dan sebelum integrasi Context Engine pertama:
permintaan Sectors menjadi demand-driven per requirement node, data yang masih
valid di-reuse, hanya yang stale/missing/incompatible di-refresh, `fetchedAt` /
`dataAsOf` / `period` / `requestedAsOf` tetap dibedakan, dan cache identity
memuat operation/argumen/asOf/period. PR E tidak mengimplementasikan ContextPacket,
Context Engine, capability registry, atau provider abstraction generik; boundary
Context Engine ↔ provider dicatat di `03-CONTEXT-AND-MEMORY.md` §12.

### Context Budget (PR J)

After assembly, the CLI budgets the rendered `ContextPacket` against the
selected agent's configured context-window capability, output reserve, prompt
components, and deterministic safety margin. Structural compaction proceeds in
stable trust-preserving stages (open questions, assumptions, assertions,
typed artifact projections, then lower-priority artifacts according to focus).
It does not mutate durable artifacts or working context and makes no provider or
LLM calls. Only the final packet that fits is persisted as `ContextSnapshot` and
sent to `MainFinHarnessAgent`; an impossible required context fails before
snapshot/model invocation. Counts are explicitly conservative estimates, and
the existing model usage metadata remains authoritative for actual provider
accounting.

## 10. Pengujian

```
packages/**/test  — unit: hash, cache, client (fetch di-inject), LLM
                    (MockLanguageModelV2), agent (fakes), store SQLite
apps/cli/test     — parser, config, E2E (spawn CLI asli, mock mode,
                    verifikasi output & state DB)
```

E2E memverifikasi: flow penuh dengan Debate ronde (5 pesan berurutan:
researcher → bull claim → bear challenge → bull response → judge decision),
integritas evidenceIds claim ⊆ evidence run, klaim rebuttal tersimpan,
skor konsisten dengan breakdown (renormalisasi), ticker tidak ditemukan →
run `failed` + error ramah, routing natural language, screener, stub.
