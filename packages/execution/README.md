# @harness/execution

Interface siklus eksekusi + validasi klaim.

| Modul | Isi |
|---|---|
| `store.ts` | `ExecutionStore` — state machine `running → completed \| failed` (transisi ganda ditolak) |
| `claimStore.ts` | `ClaimStore` + `StoredClaim` |
| `judgmentStore.ts` | `JudgmentStore` + `StoredJudgment` |
| `claimValidator.ts` | `ClaimValidator` — 3 lapis validasi: (1) struktur Zod, (2) evidence ID ada di DB, (3) evidence anggota run ini |

Catatan:
- Implementasi store SQLite ada di `@harness/database`; paket ini bebas dependensi storage.
- Kegagalan lapis 2/3 menghasilkan error `EVIDENCE_HALLUCINATION` — anti-hallucination adalah invariant, bukan saran.
