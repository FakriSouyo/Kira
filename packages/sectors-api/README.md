# @harness/sectors-api

Client Sectors API (type-safe) + cache file + mock offline.

| Modul | Isi |
|---|---|
| `types.ts` | `SectorsApi` interface, `CompanyReport`, `QuarterlyFinancials`, `ScreenerResult`, `SECTORS_SOURCES` |
| `client.ts` | `SectorsClient` — read-through cache, error tidak pernah di-cache, `SectorsApiError` (NOT_FOUND/BAD_REQUEST/UNAUTHORIZED/RATE_LIMIT/TIMEOUT/SERVER_ERROR/NETWORK), `computeMatchScore` |
| `cache.ts` | `FileCache` — TTL default 24 jam, tulis atomik (tmp + rename), key di-sanitize, file korup = miss |
| `mock.ts` | `MockSectorsApi` — fixture 5 bank (BBCA/BBRI/BMRI/BBNI/BJTM) konsisten; ticker tak dikenal → `NOT_FOUND` persis seperti client asli |
| `index.ts` | `createSectorsApi(options & { mock? })` — satu titik pembuatan |

Catatan:
- `fetchImpl` bisa di-inject (dipakai test); screener sengaja tidak di-cache.
- Skor screener (aturan eksak, teruji): profitable → ROE>0 +50; growing → revGrowth>0 +30, niGrowth>0 +20.
