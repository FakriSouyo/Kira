# Financial Agent Harness

Evidence-based stock research system — interactive REPL harness dengan multi-agent
reasoning (Researcher → Bull → Bear → Bull rebuttal → Judge), embedded SQLite,
dan audit trail penuh.

Spesifikasi lengkap: [`planning/addendum_v3.0.md`](planning/addendum_v3.0.md) (v3.1) ·
Dokumentasi teknis: [`ARCHITECTURE.md`](ARCHITECTURE.md)

## Status: Phase 0 ✅ · Phase 1 (sebagian) 🔶

- **Phase 0** — 3-agent flow **Researcher → Bull → Judge** ✅
- **Phase 1 · Debate ronde** ✅ — Bear Agent (challenge) + Bull rebuttal +
  validasi run-scoped; Judge menimbang seluruh debat
- **Phase 1 · Market & News Researcher** 📋 terspesifikasi — kontrak endpoint,
  skema evidence, dan desain agent dikunci di addendum §24-A; implementasi belum
  dimulai (lihat juga Deviasi #12 di `ARCHITECTURE.md`)
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
| `-h, --help` | Tampilkan bantuan |

Environment: lihat [`.env.example`](.env.example) — `SECTORS_API_KEY`, `LLM_PROVIDER`,
`LLM_MODEL`, `LLM_ROUTER_*`, `LLM_BASE_URL`, `LLM_API_KEY`, `FINHARNESS_HOME`,
`FINHARNESS_MOCK_SECTORS`, `FINHARNESS_MOCK_LLM`, `FINHARNESS_DEBUG`.

## Commands

| Command | Fungsi |
|---|---|
| `/judge [TICKER]` | Analisis penuh + Debate ronde: Researcher → Bull → Bear → Bull rebuttal → Judge |
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
  agent/        Bull, Bear, Judge, Intent Router (pure functions)
apps/
  cli/          REPL, command, workflow, config
```
