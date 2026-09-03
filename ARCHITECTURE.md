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
| 14 | §24-A.2 kontrak endpoint Market/News | Path HTTP riil memakai bentuk logis (`/daily-transaction`, `/foreign-flow`, `/news`, `/filings`, `/sentiment`) yang **belum diverifikasi** terhadap dokumentasi Sectors API | Dokumentasi API riil tidak dapat diakses saat implementasi (web search tak tersedia). Tipe & mock memakai kontrak logis §24-A; path harus dikonfirmasi terhadap dokumentasi Sectors API sebelum produksi — pola sama dgn Deviasi #3 (satu tempat di `client.ts`). |

## 9. Struktur Data (ringkas)

- `executions`: state machine `running → completed|failed` (transisi ganda dilarang)
- `evidence`: `UNIQUE(content_hash)` — dedup lintas run; `data` = JSON TEXT
- `agent_messages`: `UNIQUE(run_id, message_id)`, urut `sequence_order`
- `claims`: `UNIQUE(run_id, claim_id)`
- `judgments`: `UNIQUE(run_id)`, `breakdown` JSON TEXT (5 kategori)

Konvensi: **snake_case di DB ↔ camelCase di TS/Zod**, dipetakan eksplisit di
`packages/database/src/schema.ts` (satu-satunya tempat yang tahu dua konvensi).

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
