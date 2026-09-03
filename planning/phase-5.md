# Phase 5 — Polish, Metrics & Release Prep (Deployment Strategy)

> Dekomposisi pekerjaan yang bisa dieksekusi. Fondasi Phase 4 milestone bersih (197/197, session UX + web preview). Phase 5 = `Polish & Release Prep` sesuai `addendum_v3.0.md §29`: deployment strategy, distribution, versioning, metrics.

## 1. Scope terkunci

**Masuk:**
- Versioning: `package.json` → `0.2.0-rc`, `/version` command + banner dinamis (baca `package.json` version, bukan hardcode `v0.1.0`).
- Metrics & observability: `packages/shared/src/metrics.ts` helper `formatDuration`, `executionTime` polish di renderer + `/history` (tampilkan durasi).
- Help & docs polish: `renderHelp` update mencantumkan `/history`, `/session`, `/resume`, `/web`, `/export` + conditional flag docs.
- Distribution prep: `.env.example` polish + `README.md` badge version + `pnpm finharness --version` CLI flag.

**Keluar:**
- Tauri GUI penuh, pgvector, normalized tables — Future (tidak di Phase 5).
- Signing / npm publish pipeline — cukup prep, tidak publish.

## 2. Kontrak data

- Tidak ada migrasi DB baru.
- `executions.execution_time` sudah ada (Phase 0) — reuse untuk metrics.
- Version dibaca dari `package.json` (single source).

## 3. Siapa berubah (blast radius minimal)

| Area | Ubah | Tidak ubah |
|------|------|------------|
| `apps/cli/src/commands` | `version.ts` (baru), `index.ts` wiring `/version` | workflows |
| `apps/cli/src/repl` | `renderer.ts` (banner version, metrics, help) | `loop.ts`, `web.ts` |
| `packages/shared` | `metrics.ts` (baru) + `index.ts` re-export | `rubric.ts` |
| `package.json` | version bump `0.1.0 → 0.2.0-rc` | — |

## 4. Keputusan sebelum coding

- Version source: `readFileSync(join(__dirname, '../../../package.json'))` fallback `0.1.0` bila tidak ditemukan (test tidak pakai file).
- `formatDuration(msOrSec: number): string` — detik 1-desimal (`12.3s`), <1s → `0.8s`.
- Banner: `⚡ Financial Agent Harness v${version}` (dinamis).
- `/history` tambahkan kolom `time` dari `executionTime`.

## 5. Tasklist

Lihat `progress/phase-5/tasklist.md` — 3 task:

1. Version + banner dinamis — **pending**
2. Metrics helper + history time — **pending**
3. Help polish + smoke — **pending**

## 6. Verifikasi

- `pnpm check` hijau (197→200+).
- `pnpm finharness --version` cetak `0.2.0-rc`.
- `/version` di REPL cetak version.
- `/history` tampilkan `Time Xs`.

## 7. Risiko

- Membaca `package.json` di ESM via `import.meta.url` — fallback bila file tidak ada di test temp dir.
