# Design — Phase 1 (Market & News Researcher)

Dokumen **tracking**; desain final & source of truth tetap di
`planning/addendum_v3.0.md` **§24-A**. Di sini hanya **delta/keputusan yang
relevan untuk eksekusi** phase ini + lokasi kode yang disentuh.

## Tujuan

Menambahkan dua Researcher non-LLM yang menyediakan evidence Market & News agar
rubrik Judge bisa menilai **`marketMomentum`** (20%) dan **`risk`** (15%) — bukan
lagi `null`. Sebagian besar pola identik dengan Researcher fundamental (§06):
fetch → simpan evidence (dedup content-hash).

## Keputusan kunci (locked, dari §24-A)

| Aspek | Keputusan | Lokasi |
|---|---|---|
| Kontrak endpoint | `getDailyTransaction`, `getForeignFlow`, `getNews`, `getFilings`, `getSentiment` ditambah ke `SectorsApi` | `packages/sectors-api/src/types.ts`, `client.ts`, `mock.ts` |
| Source evidence | `sectors.daily_transaction`, `sectors.foreign_flow`, `sectors.news`, `sectors.filings`, `sectors.sentiment` | `SECTORS_SOURCES` |
| TTL cache | Market = 24 jam; **News = 1 jam** (`news_cache_ttl_hours`) | `client.ts`, `config.ts` |
| Jembatan rubrik | Momentum & risk diisi lewat klaim Bull/Bear yang merujuk evidence Market/News — **kontrak Judge tidak berubah** | `judgeWorkflow.ts`, `prompts/common.ts` |
| Invariant "dilihat = dicatat" | `seenEvidenceIds` di `metadata` + assertion inklusi | §24-B.1, `judgeWorkflow.ts` |
| Degradasi | Market/News gagal → kategori `null`, run `completed`; fundamental gagal / validasi gagal eksekusi → `failed` | `judgeWorkflow.ts`, `claimValidator.ts` |
| Config | `news_cache_ttl_hours`, `features.market_researcher`, `features.news_researcher` | `apps/cli/src/config.ts` |
| Error | `NEWS_UNAVAILABLE`, `VALIDATION_UNAVAILABLE` ditambah ke mapping | `context.ts` / `shared/errors.ts` |

## Delta desain vs practical (deviasi yang mungkin muncul)

> Diisi selama eksekusi bila kode menyimpang dari §24-A — catat di
> `ARCHITECTURE.md` tabel Deviasi.

- (kosong)

## Cakupan / keluar-cakupan

- **Masuk:** 5 endpoint + tipe + mock + cache; perluasan `/judge`; validasi
  invariant; render & error; test unit + E2E.
- **Keluar:** contoh data historis/komparator; skema DB (tidak ada migrasi);
  perubahan bobot rubrik.