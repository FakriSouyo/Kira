# AGENTS.md

Financial Agent Harness — monorepo pnpm untuk sistem riset saham evidence-based
multi-agent. Baca [ARCHITECTURE.md](ARCHITECTURE.md) untuk keputusan desain dan
invariant runtime, [docs/ROADMAP.md](docs/ROADMAP.md) untuk arah arsitektur, dan
[docs/PROGRESS.md](docs/PROGRESS.md) untuk status proyek sebelum mengubah
`packages/`.

## Pre-release stance: foundation over blast radius

Tanpa consumer eksternal — pilih fondasi yang benar, bukan shim kompatibilitas.
Rename/repackage bebas selama semua referensi diperbarui bersamaan.

## Repository layout

```
apps/
  cli/          REPL, commands, workflow, config (satu-satunya UI; bin `pnpm finharness`)
packages/
  shared/       canonical JSON, evidence block, rubrik, errors, constants/env
  schemas/      schema Zod (Claim, Judgment, Breakdown, Intent, Evidence, Message)
  evidence/     interface EvidenceStore + canonical hash
  conversation/ interface ConversationStore
  execution/    interface Execution/Claim/JudgmentStore + ClaimValidator
  database/     implementasi SQLite (Drizzle + better-sqlite3) + migrasi — satu-satunya yang menyentuh Drizzle
  sectors-api/  client Sectors API + file cache TTL 24h + mock
  llm/          LLMClient (Vercel AI SDK) dua-tier + custom endpoint (baseURL/apiKey) + MockLLMClient
  agent/        Bull, Bear, Judge, Intent Router (pure functions)
```

## Commands

```sh
pnpm install            # pnpm workspaces, node >= 22
pnpm finharness         # REPL (tambah --mock-sectors --mock-llm untuk offline)
pnpm test               # vitest: unit + E2E (E2E spawn CLI asli, offline)
pnpm typecheck          # tsc --noEmit (strict)
pnpm lint               # oxlint (category correctness)
pnpm check              # typecheck + test — pintu verifikasi sebelum selesai
pnpm db:migrate         # jalankan migrasi DB saja
```

## Konvensi terkunci

- **pnpm strict**: setiap paket WAJIB mendeklarasikan semua dependency yang
  di-import (`workspace:*` untuk paket internal). Import tanpa deklarasi =
  gagal resolusi — ini failure mode yang berulang, cek `package.json` dulu.
- **ESM-only**, `"type": "module"`. Jalankan dari source: `exports` menunjuk
  `src/*.ts` (diresolusi tsx/vitest). TIDAK ada build step — jangan menambah
  `lib/`/dist tanpa keputusan arsitektur.
- **Paket = pure interfaces, kecuali `database`**: agent tidak pernah menulis DB;
  workflow di `apps/cli` yang persist. Test agent memakai fakes, bukan DB.
- **Deterministik di luar LLM**: skor & stance judgment dihitung ulang oleh
  `JudgeAgent` dari breakdown via `@harness/shared` rubric.ts (bobot 25/20/20/20/15,
  renormalisasi atas kategori non-null; momentum & risk = null selama data
  market belum di-fetch).
- **Prompt cache zone**: zona [1] (preamble + `renderEvidenceBlock`) harus
  byte-identical antar agent dalam satu run — jangan masukkan data volatil
  (timestamp, UUID acak) ke zona ini. Zona [2] = persona agent.
- **Mock LLM contract**: `MockLLMClient` mendeteksi string `"Intent Router"` /
  `"Bull Agent"` / `"Bear Agent"` / `"Judge Agent"` di system prompt +
  evidence block; rebuttal Bull dideteksi dari marker `"Bear Agent raised the
  following challenges"` di prompt. Jangan mengubah teks prompt tanpa
  memperbarui `MockLLMClient` dan test-nya.
- **Errors**: selalu di-map ke `UserFriendlyError { code, message, suggestion }`
  sebelum mencapai terminal; run yang gagal tetap tercatat `failed` di DB.
- **Konvensi nama**: snake_case di DB ↔ camelCase di TS — pemetaan eksplisit
  hanya di `packages/database/src/schema.ts`.
- **Test**: `<paket>/test/*.test.ts` (vitest include sudah disetel di root).
  E2E di `apps/cli/test/e2e.test.ts` memakai mock mode — jangan menambah test
  yang membutuhkan API key/network.
- **Dokumen mengikuti perubahan**: README paket, JSDoc, dan ARCHITECTURE.md
  diperbarui dalam perubahan yang sama. JSDoc untuk kontrak non-obvious;
  komentar menyatakan kontrak (behavior, failure, ownership), bukan narasi proses.
- **Skor screen**: `computeMatchScore` memakai aturan eksak (profitable → ROE>0
  +50; growing → revGrowth>0 +30, niGrowth>0 +20). Ubah hanya dengan memperbarui
  test-nya.

## Membuang doubt, bukan fitur

Jangan menambah abstraksi, opsi konfigurasi, atau fallback tanpa consumer
yang ada sekarang. Preferensi dependensi terpelihara di atas hand-rolling
yang menambah kode yang harus dimiliki.

## Notes lingkungan (Windows)

- `pnpm ... 2>&1` di PowerShell mencetak marker `[exit code: 1]` dari stderr
  bahkan saat sukses — nilai hasil dari teks output, bukan exit code mentah.
- E2E spawn memakai `process.execPath` + `node_modules/tsx/dist/cli.mjs`
  (bin pnpm di Windows tidak andal untuk spawn langsung).
- `rmSync` ke direktori DB bisa EPERM di Windows — selalu `db.raw.close()` dulu.
