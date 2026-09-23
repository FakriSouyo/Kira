# @harness/evidence

Abstraksi penyimpanan evidence + content hashing.

| Modul | Isi |
|---|---|
| `store.ts` | Interface `EvidenceStore`; execution-scoped acceptance and reads are implemented by `@harness/database` |
| `policy.ts` | Versioned `EvidencePolicy`, financial/document candidates, deterministic policy identity, and acceptance receipts |
| `hash.ts` | `canonicalHash` (SHA-256 atas `canonicalJson`) + re-export `sortKeys`/`canonicalJson` dari `@harness/shared` |

Catatan:
- Dedup immutable content by `(content_hash, ticker, source)`; `run_evidence` stores each execution's membership and acceptance metadata.
- `data` disimpan sebagai JSON TEXT; urutan key tidak relevan karena hash memakai bentuk canonical.

`EvidenceCandidate` is not persisted Evidence. `EVIDENCE_POLICY` (`v1`) accepts
financial candidates only after reusing `verifyFinancialObservation`; it keeps
provider metadata and verification provenance, and does not infer `validAt`
from `dataAsOf`. Document search hits can be represented as typed candidates,
but T1 leaves their acceptance to a future research Execution. Accepted
membership metadata, including the policy fingerprint, is execution-scoped through `run_evidence`; use
`getManyByIdsForRun` when the caller requires the current accepting Execution.
