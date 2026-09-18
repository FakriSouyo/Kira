# Financial Agent Harness

![version](https://img.shields.io/badge/version-0.3.0-blue) ![CI](https://github.com/actions/workflows/ci.yml/badge.svg) ![node](https://img.shields.io/badge/node-%3E%3D22-green)

Evidence-based stock research harness with stateful sessions, structured context,
and explicit financial workflows. `/judge` owns the Researcher -> Bull -> Bear ->
Bull rebuttal -> Judge debate path; normal conversation runs through
`MainFinHarnessAgent` and does not auto-execute `/judge` or other slash commands.

Spesifikasi lengkap: [`planning/addendum_v3.0.md`](planning/addendum_v3.0.md) (v3.1) ·
Dokumentasi teknis: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Changelog: [`CHANGELOG.md`](CHANGELOG.md)

## Status: Phase 0→8 ✅ (0.3.0)

- **Phase 0** ✅ 3-agent flow **Researcher → Bull → Judge**
- **Phase 1** ✅ Debate ronde Bear+Bull rebuttal + Market/News Researcher (§24-A)
- **Phase 2** ✅ Advanced: session `history`/`resume`, streaming `streamText`, `export` md/html, skill-registry `--with`, replay fixture
- **Phase 3** ✅ Orchestration: `Workflow` (LangGraph evaluated→not adopted), conditional `--conditional` (seq 5–7, upsert), `where` SQL-native
- **Phase 4** ✅ Session UX + Web Preview: `/history`/`/session`/`/resume`, `/web` (3280, `/api/history`/`/api/run/:id`), conditional badge
- **Phase 5** ✅ Version `0.3.0` + `/version`/`--version`, `formatDuration`, help lengkap
- **Phase 6** ✅ Final RC `eval.md` agregat 0→6
- **Phase 7** ✅ Future prototype: vector `mockEmbedding` + `cosineSimilarity`, `searchEvidence` + `/search`
- **Phase 8** ✅ Release: CI (`pnpm check`), `CHANGELOG.md`, README distribusi
- Sectors API client (v2, file cache TTL 24h/1h news, `where` native, error mapping)
- LLM dua-tier (agent+router, `maxTokens` 2000/256, custom `baseURL`/`apiKey`, Vercel AI SDK)
- 3 lapis validasi claim + `assertSeenEvidence` invariant
- REPL interaktif: slash command, tab completion, history, Ctrl+C best-effort, natural language via MainFinHarnessAgent dengan structured context follow-up
- Mock mode penuh (sectors+LLM) — **jalan offline tanpa API key**
- Vector prototype (Phase 7) — `mockEmbedding` placeholder `pgvector`

## Stateful Harness A-L ✅

The current runtime has completed the A-L stateful-context roadmap:

```text
Session -> Turn -> Execution
              |
              +-> /judge -> Evidence -> Bull/Bear/Judge -> typed artifacts
              |
              +-> conversation -> SessionWorkingContext
                                  -> Resolver / Retrieval / Policy / Assembler
                                  -> Token Budget / Compaction
                                  -> ContextSnapshot
                                  -> ModelCall
```

Key boundaries:

- `/judge` is the only workflow that owns the Bull/Bear/Judge debate.
- Other commands keep independent workflow semantics and do not implicitly invoke the debate.
- Natural-language conversation may answer from existing context or recommend a command, but does not auto-run commands.
- PR L artifact reuse means reuse as prior context only, not workflow-output memoization.
- Bull/Bear/Judge specialist context remains scoped to the current `/judge` execution and authoritative Evidence.

## Requirements

- Node.js ≥ 22 (built-in `fetch`)
- pnpm ≥ 9

## Quickstart (offline, tanpa API key)

```bash
pnpm install
pnpm finharness --mock-sectors --mock-llm
```

Lalu di REPL:

```
❯ /judge BBCA
❯ Apakah BBRI layak dibeli?
❯ /screen profitable growing
❯ /history
❯ /session <runId>
❯ /search ROE
❯ /export <runId> --format md
❯ /web
❯ /version
❯ /help
❯ /exit
```

## Quickstart (real API)

```bash
cp .env.example .env   # isi SECTORS_API_KEY + key LLM
pnpm finharness
```

Atau via `~/.finharness/config.json`:

```json
{
  "llm": {
    "agent":  { "provider": "openai", "model": "gpt-4o", "temperature": 0.2, "maxTokens": 2000 },
    "router": { "provider": "openai", "model": "gpt-4o-mini", "temperature": 0.0, "maxTokens": 256 }
  },
  "sectors_api": { "key": "SECTORS_API_KEY", "base_url": "https://api.sectors.app/v2", "cache_ttl_hours": 24 },
  "features": { "auto_sync": true, "mock_mode": false }
}
```

> **Kredensial terpisah (`.credentials.json`, opsional).** Untuk menghindari key mentah
> nangkring di `config.json` (aman dibagikan/screenshot untuk debug), preferensi key:
> **env → `~/.finharness/.credentials.json` → config.json (legacy) → default**.
>
> ```json
> // ~/.finharness/.credentials.json
> {
>   "sectors_api": { "key": "..." },
>   "llm": { "agent": { "api_key": "..." }, "router": { "api_key": "..." } }
> }
> ```
>
> `sectors_api.key` / `llm.*.api_key` di `config.json` (baris `"key"` di atas) tetap dibaca
> sebagai **fallback legacy** agar tidak breaking. Untuk CI/headless cukup pakai env
> (`SECTORS_API_KEY`, `LLM_API_KEY`) yang menggantikan keduanya.
>
> Di dalam REPL langsung set lewat `/auth-set SECTORS=... LLM.AGENT=... LLM.ROUTER=...`
> (menulis `.credentials.json` otomatis dengan mode `0600` di *nix).

Prioritas konfigurasi: **env → `.credentials.json` → config.json → default** (env menang bila ada).

### Custom API provider (DeepSeek, OpenRouter, Ollama lokal, dsb.)

Endpoint OpenAI-compatible apa pun bisa dipakai lewat `base_url` + `api_key`
(di `config.json`, per-tier) atau env `LLM_BASE_URL` + `LLM_API_KEY` (kedua tier):

```bash
# DeepSeek
LLM_PROVIDER=openai LLM_BASE_URL=https://api.deepseek.com/v1 LLM_API_KEY=sk-... LLM_MODEL=deepseek-chat pnpm finharness

# Ollama lokal (tanpa internet)
LLM_PROVIDER=openai LLM_BASE_URL=http://localhost:11434/v1 LLM_API_KEY=ollama LLM_MODEL=qwen2.5:14b pnpm finharness
```

Router tier yang berbeda model/provider cukup diset di `config.json`
(`llm.router.base_url` / `llm.router.api_key`).

## CLI Options

| Flag | Fungsi |
|---|---|
| `--home <dir>` | Direktori data (default `~/.finharness`) |
| `--mock-sectors` | Data fiks Sectors API (offline) |
| `--mock-llm` | LLM deterministik (offline) |
| `--version` | Tampilkan versi (`0.3.0`) |
| `-h, --help` | Tampilkan bantuan |

Environment: lihat [`.env.example`](.env.example) — `SECTORS_API_KEY`, `LLM_PROVIDER`,
`LLM_MODEL`, `LLM_ROUTER_*`, `LLM_BASE_URL`, `LLM_API_KEY`, `FINHARNESS_HOME`,
`FINHARNESS_MOCK_SECTORS`, `FINHARNESS_MOCK_LLM`, `FINHARNESS_DEBUG`.

## Commands

| Command | Fungsi |
|---|---|
| `/judge [TICKER]` | Analisis penuh + Debate ronde: Researcher → Bull → Bear → Bull rebuttal → Judge (`--conditional` Phase 3) |
| `/screen [CRITERIA]` | Screener (`profitable`/`growing`, `where` native Phase 3) — pola historis |
| `/history [--limit N]` | List runs (Phase 4) |
| `/session <runId>` | Show artifacts markdown (Phase 4) |
| `/resume <runId>` | Alias session (Phase 4) |
| `/search <query>` | Search evidence (keyword+vector prototype, Phase 7) |
| `/export <runId> [--format json\|md\|html]` | Export audit trail (Phase 2) |
| `/web [--port N]` | Tiny web preview `http://localhost:3280` (Phase 4) |
| `/version` | Tampilkan versi (Phase 5) |
| `/help` | Bantuan |
| `/exit` | Keluar |
| `/challenge`, `/compare`, `/research`, `/investigate` | Stub roadmap (Phase 1) |

Natural language ditangani oleh `MainFinHarnessAgent`. Agent dapat menjawab dari
context yang tersedia atau menyarankan slash command yang lebih sesuai, tetapi
tidak mengeksekusi `/judge`, `/research`, `/compare`, atau `/screen` secara
implisit. Command berjalan ketika dipanggil secara eksplisit.

## Development

```bash
pnpm check         # typecheck + test — satu pintu verifikasi
pnpm test          # seluruh suite (unit + E2E offline)
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint (correctness)
pnpm db:migrate    # jalankan migrasi DB saja
```

Konvensi kontribusi & struktur: [`AGENTS.md`](AGENTS.md) · per-paket: lihat
`README.md` di masing-masing `packages/*` dan `apps/cli`.

Struktur monorepo saat ini:

```
packages/
  command/      kontrak dan definisi workflow command, termasuk /judge
  context/      ContextPacket, retrieval, validity, policy, budget, snapshot
  conversation/ durable conversation store contracts
  database/     SQLite stores + migrations
  evidence/     EvidenceStore + hashing/provenance
  execution/    lifecycle validators, claim/judgment store contracts
  llm/          provider-facing LLM runtime contracts + mock
  orchestrator/ MainFinHarnessAgent conversation orchestration
  routing/      routing primitives
  schemas/      shared Zod/domain schemas
  sectors-api/  Sectors provider adapter + cache/freshness policy
  session/      canonical Session/Turn/Execution + SessionWorkingContext
  shared/       common utilities
  skill/        skill contracts/providers
  subagent/     Bull, Bear, Judge, Researcher, and shared specialist runtime
apps/
  cli/          REPL, composition, command adapters, workflow/runtime wiring
```
