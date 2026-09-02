# @harness/evidence

Abstraksi penyimpanan evidence + content hashing.

| Modul | Isi |
|---|---|
| `store.ts` | Interface `EvidenceStore` (save/get/getByIds) — implementasi SQLite di `@harness/database` |
| `hash.ts` | `canonicalHash` (SHA-256 atas `canonicalJson`) + re-export `sortKeys`/`canonicalJson` dari `@harness/shared` |

Catatan:
- Dedup: `UNIQUE(content_hash)` di tabel `evidence` — konten identik lintas run disimpan sekali.
- `data` disimpan sebagai JSON TEXT; urutan key tidak relevan karena hash memakai bentuk canonical.
