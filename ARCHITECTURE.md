# ARCHITECTURE — Financial Agent Harness (Phase 0)

Dokumen teknis: bagaimana sistem dibangun, keputusan desain yang diambil, dan
deviasi terdokumentasi dari addendum v3.1.

## 1. Layer & Abstraksi (Locked)

```
apps/cli (REPL + commands + workflows)          ← satu-satunya UI
        │
packages/agent (Bull, Judge, Router)            ← pure functions, tanpa DB write
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

## 2. Evidence-First Flow (/judge)

1. **Researcher** (bukan LLM): fetch `company_report` + `quarterly_financials`
   → simpan ke Evidence Store dengan dedup content-hash (SHA-256 canonical JSON).
2. **Bull**: system prompt 2 zona → `generateObject` (Zod) → reasoning + klaim.
3. **Validasi 3 lapis** (`ClaimValidator`):
   - Layer 1: struktur (Zod — `evidenceIds` non-kosong, uuid valid)
   - Layer 2: evidence ID ada di DB (anti-hallucination)
   - Layer 3: evidence termasuk allowed set run ini (anti cross-run contamination)
4. **Judge**: klaim + conversation → `generateObject` → judgment rubrik 5 kategori.
5. Persist: `executions` (state machine running→completed/failed), `agent_messages`
   (sequence_order), `claims`, `judgments` — audit trail penuh per `run_id`.

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
Phase 0: momentum & risk = null → bobot 25/20/20 direnormalisasi atas 65
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
    riil (ROE, growth YoY) dengan confidence berbasis threshold
  - Judge: menghitung jumlah klaim per confidence dari prompt, skor via rubrik
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
`SERVER_ERROR`, `NETWORK` (Sectors), `EVIDENCE_HALLUCINATION` (validasi),
`INVALID_TICKER`, `MISSING_TICKER`, `BEAR_NOT_AVAILABLE`, `UNKNOWN_ERROR`.
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

E2E memverifikasi: 3-agent flow penuh, integritas evidenceIds claim ⊆ evidence
run, skor konsisten dengan breakdown (renormalisasi), ticker tidak ditemukan →
run `failed` + error ramah, routing natural language, screener, stub.
