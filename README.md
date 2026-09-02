# Financial Agent Harness

Evidence-based stock research system — interactive REPL harness dengan multi-agent
reasoning (Researcher → Bull → Judge), embedded SQLite, dan audit trail penuh.

Spesifikasi lengkap: [`planning/addendum_v3.0.md`](planning/addendum_v3.0.md) (v3.1) ·
Dokumentasi teknis: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Status: Phase 0 ✅

- 3-agent flow: **Researcher → Bull → Judge** (Bear/debate = Phase 1, skema DB sudah di-reserve)
- Sectors API client (type-safe, file cache TTL 24 jam, error mapping)
- LLM dua-tier (agent + router) via Vercel AI SDK, retry backoff, `maxTokens` terkunci
- 3 lapis validasi claim (struktur Zod → keberadaan evidence → keanggotaan run)
- REPL interaktif: slash command, tab completion, history, Ctrl+C, natural language input
- Mock mode penuh (sectors + LLM) — **jalan offline tanpa API key**

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
  "sectors_api": { "key": "SECTORS_API_KEY", "base_url": "https://api.sectors.app/v1", "cache_ttl_hours": 24 },
  "features": { "auto_sync": true, "mock_mode": false }
}
```

Prioritas konfigurasi: **env → config.json → default** (env menang bila keduanya ada).

## CLI Options

| Flag | Fungsi |
|---|---|
| `--home <dir>` | Direktori data (default `~/.finharness`) |
| `--mock-sectors` | Data fiks Sectors API (offline) |
| `--mock-llm` | LLM deterministik (offline) |
| `-h, --help` | Tampilkan bantuan |

Environment: lihat [`.env.example`](.env.example) — `SECTORS_API_KEY`, `LLM_PROVIDER`,
`LLM_MODEL`, `LLM_ROUTER_*`, `FINHARNESS_HOME`, `FINHARNESS_MOCK_SECTORS`,
`FINHARNESS_MOCK_LLM`, `FINHARNESS_DEBUG`.

## Commands

| Command | Fungsi |
|---|---|
| `/judge [TICKER]` | Analisis penuh: Researcher → Bull → Judge |
| `/screen [CRITERIA]` | Screener (mis. `/screen profitable growing`) — pola historis, bukan prediksi |
| `/help` | Bantuan |
| `/exit` | Keluar |
| `/challenge`, `/compare`, `/research`, `/investigate` | Stub roadmap (Phase 1) |

Natural language juga langsung jalan: *"Saham apa yang konsisten tumbuh?"* → `/screen`,
*"Apakah BBCA layak dibeli?"* → `/judge BBCA`.

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

Struktur monorepo:

```
packages/
  shared/       utils: error, constants, canonical JSON, evidence block, rubrik
  schemas/      schema Zod (Claim, Judgment, Breakdown, Intent, Evidence, Message)
  evidence/     interface EvidenceStore + content hashing
  conversation/ interface ConversationStore
  execution/    interface Execution/Claim/JudgmentStore + ClaimValidator
  database/     implementasi SQLite (Drizzle + better-sqlite3) + migrasi
  sectors-api/  client Sectors API + file cache + mock
  llm/          LLMClient (Vercel AI SDK) dua-tier + MockLLMClient
  agent/        Bull, Judge, Intent Router (pure functions) + stub Bear
apps/
  cli/          REPL, command, workflow, config
```
