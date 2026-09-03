# Rules — Phase 1 (Market & News Researcher)

Konvensi khusus Phase 1 yang **belum** tercakup di `AGENTS.md` / `ARCHITECTURE.md`.
Aturan global tetap di `AGENTS.md`; dokumen ini hanya delta.

## Kontrak endpoint & source evidence

- Setiap sumber evidence memakai `source = "sectors.<snake_endpoint>"` dan
  dimasukkan ke `SECTORS_SOURCES` (`packages/sectors-api/src/types.ts`).
  Phase 1 menambah: `sectors.daily_transaction`, `sectors.foreign_flow`,
  `sectors.news`, `sectors.filings`, `sectors.sentiment`.
- Kontrak HTTP riil (path/query/field) di**verifikasi terhadap dokumentasi API
  saat implementasi** — dikunci di `client.ts` sebagai satu tempat (Deviasi #3).
  Tipe/mock memakai kontrak logis §24-A.3–4.

## Caching

- Fundamental & Market: file cache TTL **24 jam** (`cache_ttl_hours`).
- **News** (`sectors.news`, dan sentimen turunannya): TTL **1 jam**
  (`news_cache_ttl_hours`) — semi-volatil.
- TTL per-source diteruskan dari config ke `SectorsClient`; kwargs default.

## Degradasi (garis pemisah — addendum §24-A.5 & §24-B.3)

- **Enrichment opsional** (Market/News): sumber gagal → kategori rubrik terkait
  `null`, run **tetap `completed`** + catatan "market/news unavailable".
- **Jaminan integritas (fail-closed)**: gagal **mengeksekusi** validasi (DB/network
  saat cek eksistensi/keanggotaan) → run `failed` (`VALIDATION_UNAVAILABLE`).
  Jangan terjemahkan diam-diam jadi "lolos".
- Kegagalan **researcher fundamental** → run `failed`.

## Rubrik & jembatan breakdown

- Bobot rubrik **tidak berubah** (25/20/20/20/15). Momentum & risk diisi lewat
  **klaim Bull/Bear yang merujuk evidence Market/News**, bukan dengan mengubah
  kontrak Judge (Judge tetap terima `claims` + `conversation`).
- Invariant "yang dilihat = yang dicatat" (§24-B.1): `agent_messages.metadata.seenEvidenceIds`
  byte-identical dgn evidence block zona [1]; assertion `claim.evidenceIds ⊆
  seenEvidenceIds` — melempar error, bukan warning.

## Pengujian (TDD)

- Tulis/update test **bersama** perubahan (konvensi AGENTS.md).
- Mock deterministik untuk offline: `--mock-sectors` + `--mock-llm` harus bisa
  membuktikan breakdown 5 kategori non-null tanpa API key.
- E2E mock-mode tetap naik-invariant: `pnpm check` harus hijau sebelum commit.