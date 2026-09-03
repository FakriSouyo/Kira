# Tasklist — Phase 1 (Market & News Researcher)

Checklist hidup ber-status. Sumber task: `addendum_v3.0.md` §24-A.7. Status:
☐ pending · 🔵 in-progress · ✅ done · ⏳ blocked

## Baseline (sebelum implementasi)

- [x] ✅ Debate ronde (Bear + Bull rebuttal) — selesai & lolos `pnpm check`
- [x] ✅ Dokumentasi §24-A (Market/News spec) & §24-B (pola disiplin) ditulis

## Task 21 — Gate & kontrak endpoint Market/News
- [ ] ☐ Tipe `DailyTransaction`, `ForeignFlow`, `NewsArticle`, `Filing`, `Sentiment` di `sectors-api/types.ts`
- [ ] ☐ Tambah 5 method ke interface `SectorsApi`
- [ ] ☐ `SECTORS_SOURCES` diperluas
- [ ] ☐ `MockSectorsApi` fixture deterministik (BBCA likuid+positif, BJTM likuiditas rendah)
- [ ] ☐ Unit test kontrak/mock

## Task 22 — Client HTTP + cache
- [ ] ☐ Implementasi `SectorsClient` (getDailyTransaction, getForeignFlow, getNews, getFilings, getSentiment)
- [ ] ☐ TTL khusus News (1 jam) terhubung ke config
- [ ] ☐ Test: mock 404/rate-limit, cache hit kurangi panggilan, news TTL lebih pendek

## Task 23 — Flow /judge diperluas
- [ ] ☐ Researcher market & news menambah evidence ke run
- [ ] ☐ `allowedEvidenceIds` = fundamental + market + news
- [ ] ☐ Degradasi: Market/News gagal → kategori null + run completed
- [ ] ☐ Invariant `seenEvidenceIds` + assertion inklusi
- [ ] ☐ E2E: breakdown momentum/risk non-null saat mock menyediakan kedua grup

## Task 24 — Prompt zonasi & MockLLM momentum/risk
- [ ] ☐ `buildEvidenceZone` menerima kelompok evidence (fundamental/market/news) tetap byte-identical
- [ ] ☐ `MockLLMClient` membaca evidence Market → breakdown momentum/risk riil
- [ ] ☐ Update test mock LLM

## Task 25 — Rubrik 5 kategori + degradasi parsial
- [ ] ☐ `normalizeJudgmentScore` bekerja pada breakdown 5 kategori & parsial (3/4)
- [ ] ☐ Test: breakdown penuh → Σwᵢsᵢ/100; satu sumber gagal → kategori null, run completed

## Task 26 — Renderer & error
- [ ] ☐ Renderer tampilkan momentum & risk (hapus label "not evaluated")
- [ ] ☐ Catatan "market/news unavailable" bila null
- [ ] ☐ `NEWS_UNAVAILABLE`, `VALIDATION_UNAVAILABLE` dipetakan

## Verifikasi akhir
- [ ] ☐ `pnpm check` hijau (typecheck + seluruh unit/E2E)
- [ ] ☐ Update `ARCHITECTURE.md` (deviasi bila ada) + tasklist status
- [ ] ☐ Commit Phase 1 penuh