# @harness/llm

Akses LLM dua-tier via Vercel AI SDK + mock deterministik untuk development offline.

| Modul | Isi |
|---|---|
| `types.ts` | `LLMModelConfig` (termasuk `baseURL?`/`apiKey?`), `SystemZones` (string \| string[]), `LLMClientLike { generateObject, generateText }` |
| `config.ts` | `DEFAULT_AGENT_CONFIG` (gpt-4o, t0.2, 2000 tok), `DEFAULT_ROUTER_CONFIG` (gpt-4o-mini, t0.0, 256 tok), `loadLLMConfig` (env `LLM_BASE_URL`/`LLM_API_KEY` global → kedua tier) |
| `client.ts` | `LLMClient` — `maxOutputTokens`, retry backoff untuk error ber-`code` retryable; `classifyLLMError`; `createProvider` (custom endpoint); zona digabung jadi satu string system prompt |
| `mock.ts` | `MockLLMClient` deterministik — membaca evidence block dari zona [1], output divalidasi Zod schema pemanggil |
| `index.ts` | `createLLMClient`, `createDefaultClients({ agent?, router? })` |

**Custom API provider** (`baseURL` + `apiKey` di `LLMModelConfig`):
dukung endpoint OpenAI-compatible apa pun — DeepSeek, OpenRouter, Groq,
Ollama/LM Studio lokal, vLLM. Resolusi model selalu memakai **chat completions**
(`provider.chat(model)`) — protokol universal; call default provider OpenAI
memakai Responses API yang hanya ada di OpenAI asli, jadi tidak bisa untuk
endpoint kustom. `apiKey` kosong → SDK membaca `OPENAI_API_KEY`/
`ANTHROPIC_API_KEY`.

Catatan:
- AI SDK 5.0.250 mem-retry `APICallError` 429/5xx secara internal (dengan Retry-After); retry di LLMClient adalah lapisan kedua untuk error yang dibungkus — keduanya tidak boleh duplikat backoff.
- Breakpoint `cache_control` eksplisit (Anthropic) ditunda — SDK men-tipekan `system: string` saja. Lihat ARCHITECTURE.md → Deviations #1.
- Kontrak mock: string `"Intent Router"` / `"Bull Agent"` / `"Judge Agent"` harus tetap ada di prompt (`@harness/agent`).
- `generateText`/`generateObject` (AI SDK 5) memakai jalur non-streaming JSON (bukan SSE) — teruji oleh fake server OpenAI-compatible di `test/client.test.ts`.
