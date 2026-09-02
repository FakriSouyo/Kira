# @harness/llm

Akses LLM dua-tier via Vercel AI SDK + mock deterministik untuk development offline.

| Modul | Isi |
|---|---|
| `types.ts` | `LLMModelConfig`, `SystemZones` (string \| string[]), `LLMClientLike { generateObject, generateText }` |
| `config.ts` | `DEFAULT_AGENT_CONFIG` (gpt-4o, t0.2, 2000 tok), `DEFAULT_ROUTER_CONFIG` (gpt-4o-mini, t0.0, 256 tok), `loadLLMConfig` |
| `client.ts` | `LLMClient` — `maxOutputTokens`, retry backoff untuk error ber-`code` retryable; `classifyLLMError`; zona digabung jadi satu string system prompt |
| `mock.ts` | `MockLLMClient` deterministik — membaca evidence block dari zona [1], output divalidasi Zod schema pemanggil |
| `index.ts` | `createLLMClient`, `createDefaultClients({ agent?, router? })` |

Catatan:
- AI SDK 5.0.250 mem-retry `APICallError` 429/5xx secara internal (dengan Retry-After); retry di LLMClient adalah lapisan kedua untuk error yang dibungkus — keduanya tidak boleh duplikat backoff.
- Breakpoint `cache_control` eksplisit (Anthropic) ditunda — SDK men-tipekan `system: string` saja. Lihat ARCHITECTURE.md → Deviations #1.
- Kontrak mock: string `"Intent Router"` / `"Bull Agent"` / `"Judge Agent"` harus tetap ada di prompt (`@harness/agent`).
