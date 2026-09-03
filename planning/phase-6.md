# Phase 6 — Final Verification & Release Candidate (RC → Release)

> Dekomposisi pekerjaan final. Fondasi Phase 5 milestone bersih (203/203, version 0.2.0-rc + metrics). Phase 6 = `Release Candidate Polish` — evaluasi menyeluruh terhadap `addendum_v3.0.md §04–§29` dan penguncian `0.2.0`.

## 1. Scope terkunci

**Masuk:**
- Evaluasi lintas-phase (0→5) terhadap addendum — tabel kepatuhan §04–§29, deviasi final.
- Bump version `0.2.0-rc → 0.2.0` + `ARCHITECTURE.md` final, `README.md` badge versi.
- Final smoke: `pnpm check` hijau + offline E2E `/judge → /history → /session → /export → /web` + `--version`.
- Catatan rilis `progress/phase-6/eval.md` (gate penguncian).

**Keluar:**
- Fitur baru besar — stop di Phase 6 (sesuai instruksi: 6 atau 7). Phase 7 tidak dibuat kecuali ada kebutuhan future (pgvector).
- Tauri GUI penuh, pgvector — Future.

## 2. Kontrak data

- Tidak ada migrasi DB baru — reuse, final.
- Version single source `package.json`.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `package.json` | version `0.2.0` | — |
| `apps/cli/src/commands/version.ts` | fallback tetap `0.1.0` tapi real `0.2.0` | — |
| `ARCHITECTURE.md`, `README.md` | Tabel deviasi final, badge | — |
| `planning/phase-6.md`, `progress/phase-6/*` | Dokumen gate | — |

## 4. Keputusan

- Stop di Phase 6 — Phase 7 hanya bila ada consumer pgvector/Tauri (tidak sekarang).
- Evaluasi tiap phase sudah dilakukan sebelum lanjut (Phase 2→3→4→5), Phase 6 adalah evaluasi final agregat.

## 5. Tasklist

Lihat `progress/phase-6/tasklist.md` — 3 task:

1. Evaluasi lintas-phase vs addendum — **pending**
2. Bump version 0.2.0 + docs — **pending**
3. Final smoke + gate — **pending**

## 6. Verifikasi

- `pnpm check` 203+ tetap hijau.
- `pnpm finharness --version` → `0.2.0`.
- E2E offline tetap hijau.

## 7. Risiko

- None — polish only, tidak sentuh logic inti.
