# Tasklist — Phase 1 (Market & News Researcher)

Checklist hidup ber-status. Sumber task: `addendum_v3.0.md` §24-A.7. Status:
☐ pending · 🔵 in-progress · ✅ done · ⏳ blocked

## Baseline (sebelum implementasi)

- [x] ✅ Debate ronde (Bear + Bull rebuttal) — selesai & lolos `pnpm check`
- [x] ✅ Dokumentasi §24-A (Market/News spec) & §24-B (pola disiplin) — committed `528b5f5`

## Task 21 — Gate & kontrak endpoint Market/News
- [x] ✅ Tipe `DailyTransaction`, `ForeignFlow`, `NewsArticle`, `Filing`, `Sentiment` di `sectors-api/types.ts`
- [x] ✅ 5 method ditambah ke interface `SectorsApi`
- [x] ✅ `SECTORS_SOURCES` diperluas
- [x] ✅ `MockSectorsApi` fixture deterministik (BBCA likuid+positif, BJTM likuiditas rendah)
- [x] ✅ Unit test kontrak/mock (5 endpoint + fixture + 404)

## Task 22 — Client HTTP + cache
- [x] ✅ Implementasi `SectorsClient` (getDailyTransaction, getForeignFlow, getNews, getFilings, getSentiment)
- [x] ✅ TTL khusus News (1 jam) via `newsCache` instance + `newsCacheTtlHours`
- [x] ✅ Test: URL fetch, cache hit, **TTL news < fundamental (deterministik)**, 404

## Task 23 — Flow /judge diperluas
- [x] ✅ Researcher market & news menambah evidence ke run (degrade saat gagal)
- [x] ✅ `allowedEvidenceIds` = fundamental + market + news
- [x] ✅ Degradasi: Market/News gagal → kategori null + run completed
- [x] ✅ Invariant `seenEvidenceIds` + assertion `assertSeenEvidence`
- [x] ✅ E2E: breakdown momentum/risk non-null saat mock menyediakan kedua grup

## Task 24 — Prompt zonasi & MockLLM momentum/risk
- [x] ✅ Bull mock menghasilkan klaim momentum (market) & risk (sentiment)
- [x] ✅ Judge mock mengisi `marketMomentum` & `risk` dari klaim; null bila tidak ada
- [x] ✅ Unit test mock market/news

## Task 25 — Rubrik 5 kategori + degradasi parsial
- [x] ✅ `normalizeJudgmentScore` teruji pada breakdown 5 kategori (over 100) & parsial
- [x] ✅ Test: breakdown penuh → Σwᵢsᵢ/100; degradasi parsial → renorm bobot tersisa

## Task 26 — Renderer & error
- [x] ✅ Renderer tampilkan evidence market/news + status unavailable; fallback "data unavailable"
- [x] ✅ `VALIDATION_UNAVAILABLE` (fail-closed §24-B.3) di `ClaimValidator.readEvidence`
- [x] ✅ Momentum & risk dimunculkan di breakdown

## Verifikasi akhir
- [x] ✅ `pnpm check` hijau (typecheck + 137 test, 17 file)
- [x] 🔵 ARCHITECTURE deviasi & tasklist status di-update
- [ ] ☐ Commit Phase 1 penuh