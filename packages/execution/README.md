# @harness/execution

Interface siklus eksekusi + validasi klaim.

| Modul | Isi |
|---|---|
| `store.ts` | `ExecutionStore` — state machine `running → completed \| failed` (transisi ganda ditolak) |
| `claimStore.ts` | `ClaimStore` + `StoredClaim` |
| `judgmentStore.ts` | `JudgmentStore` + `StoredJudgment` |
| `counterpointStore.ts` | `CounterpointStore` + `StoredCounterpoint` |
| `claimValidator.ts` | `ClaimValidator` — 3 lapis validasi: (1) struktur Zod, (2) evidence ID ada di DB, (3) evidence anggota run ini |
| `claimPolicy.ts` | `claim-policy-v1` — mengubah Bull `ClaimProposal` menjadi Claim kanonik dengan tautan Evidence eksplisit, grounding angka, dan anotasi `singleMetric` deterministik |
| `counterpointPolicy.ts` | `counterpoint-policy-v1` — mengubah Bear proposal menjadi Counterpoint kanonik dengan target Claim, Evidence links, CitedFigures, dan identitas code-owned yang deterministik |
| `numericGrounding.ts` | Helper sempit untuk literal angka `%`, `x`, dan `bps` yang dipakai Claim Policy dan Counterpoint Policy |

Catatan:
- Implementasi store SQLite ada di `@harness/database`; paket ini bebas dependensi storage.
- Evidence Claim dibaca melalui membership Execution, termasuk `legacy-v0` untuk resume historis. Writer Claim saat ini mensyaratkan hasil Claim Policy; hanya repair checkpoint historis yang boleh memproyeksikan Claim tanpa identitas policy.
- Counterpoint Policy memvalidasi Evidence terhadap selection/response dan membership Execution. `CounterpointStore` adalah kontrak domain; implementasi SQLite dan projection Execution berada di `@harness/database`.
- Kegagalan validasi menghasilkan error `EVIDENCE_HALLUCINATION` — anti-hallucination adalah invariant, bukan saran.
