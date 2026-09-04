# Phase 8 — Release & Distribution (Hardening)

> Dekomposisi pekerjaan final. Fondasi Phase 7 milestone bersih (211/211, vector prototype + /search). Phase 8 = `Release & Distribution` — hardening pasca-Future: CI, CHANGELOG, README distribusi, version `0.3.0` (addendum §29 deployment strategy, tanpa menambah runtime deps).

## 1. Scope terkunci (apa & apa bukan)

**Masuk (hardening, bukan fitur):**
- CI workflow `\.github/workflows/ci.yml` — `pnpm check` (typecheck + test) pada `node 22`, cache pnpm.
- `CHANGELOG.md` — auto-extract dari `git log --oneline` Phase 2→7 + `ARCHITECTURE.md` deviasi final.
- `README.md` polish — badge `v0.3.0`, quickstart `--mock`, daftar slash commands lengkap (0→7: `/judge`/`/screen`/`/history`/`/session`/`/resume`/`/search`/`/export`/`/web`/`/version`), bagian `Vector prototype (Phase 7)`.
- Bump version `0.2.0 → 0.3.0` (`package.json`) — selaras Phase 8 distribusi (minor bump untuk Future).
- `pnpm lint` / `oxlint` pass (jika lint tersedia, tidak memaksa).

**Keluar (deferred Future penuh):**
- npm publish token, Tauri build, pgvector real — tetap Future (tidak dikerjakan Phase 8).
- Binari platform-specific — cukup `pnpm finharness`.

## 2. Kontrak data (reuse DB)

- Tidak ada migrasi DB baru, tidak ada perubahan `packages/*` runtime (kecuali bump version).
- CI read-only, tidak sentuh `schema.ts`.

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `.github/workflows/ci.yml` | Baru | `packages/**` |
| `CHANGELOG.md` | Baru | `planning/addendum_v3.0.md` locked |
| `README.md` | Polish badge + commands + Phase 7 section | `AGENTS.md` |
| `package.json` | version `0.3.0` | — |
| `planning/`, `progress/phase-8/` | docs | — |

## 4. Keputusan sebelum coding

- CI: `actions/checkout@v4`, `pnpm/action-setup@v4`, Node 22, `pnpm install --frozen-lockfile`, `pnpm check`. Tidak pakai `actions/cache` manual (pnpm action handle).
- CHANGELOG: entri Phase 0→8 ringkas (bukan full git log mentah) — supaya readable.
- README polish minimal: badge version, offline quickstart, tabel commands.

## 5. Tasklist (TDD, `pnpm check` tiap commit)

Lihat `progress/phase-8/tasklist.md` — 3 task:

1. CI workflow — **pending**
2. CHANGELOG + README — **pending**
3. Bump version + smoke — **pending**

## 6. Verifikasi

- `pnpm check` hijau (211+ tetap hijau).
- `git log --oneline` Phase 8 commit ada.
- CI file valid YAML (tidak di-run di local, tapi `pnpm check` tetap jalan).

## 7. Risiko

- CI YAML salah — validasi via `yamllint` mental; tidak mem-block `pnpm check`.
