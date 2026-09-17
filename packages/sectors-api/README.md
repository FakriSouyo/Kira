# @harness/sectors-api

Client Sectors API (type-safe) + cache file + mock offline.

| Modul | Isi |
|---|---|
| `types.ts` | `SectorsApi` interface, `CompanyReport`, `QuarterlyFinancials`, `ScreenerResult`, `SECTORS_SOURCES` |
| `client.ts` | `SectorsClient` — read-through cache, error tidak pernah di-cache, `SectorsApiError` (NOT_FOUND/BAD_REQUEST/UNAUTHORIZED/RATE_LIMIT/TIMEOUT/SERVER_ERROR/NETWORK), `computeMatchScore` |
| `cache.ts` | `FileCache` — TTL atau snapshot tanggal lokal, tulis atomik (tmp + rename), key di-sanitize, file korup = miss |
| `policy.ts` | Normalized provider requirement identity dan inspectable `reuse`/`fetch` freshness decisions |
| `mock.ts` | `MockSectorsApi` — fixture 5 bank (BBCA/BBRI/BMRI/BBNI/BJTM) konsisten; ticker tak dikenal → `NOT_FOUND` persis seperti client asli |
| `index.ts` | `createSectorsApi(options & { mock? })` — satu titik pembuatan |

Catatan:
- `fetchImpl` bisa di-inject (dipakai test); screener sengaja tidak di-cache.
- Company Report meminta hanya sections `overview`, `valuation`, `financials`, dan `dividend`; response campuran memakai TTL konservatif dan `asOf` tidak dianggap sebagai periode finansial.
- Latest quarterly financials meminta `n_quarters=1` setelah parity characterization; bila YoY tidak tersedia dari report, client mempertahankan derivasi multi-quarter sebagai fallback.
- Cache identity hanya memakai provider operation, normalized parameters, subject scope, temporal semantics, schema, dan adapter. Workflow/command/Turn/Execution/run tidak menjadi identity; provider hit tetap menghasilkan Evidence baru per Execution.
- Daily/Foreign meminta range historis yang berakhir pada hari sebelumnya agar row trading-day yang masih berkembang tidak masuk cache; data historis selesai memakai validity calendar-day. News/Filings memakai TTL pendek yang dikonfigurasi. Shared/on-demand IDX endpoints dan screener tetap di luar normal `/judge` cache surface.
- Skor screener (aturan eksak, teruji): profitable → ROE>0 +50; growing → revGrowth>0 +30, niGrowth>0 +20.
