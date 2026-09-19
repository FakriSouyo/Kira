# @harness/llm

Akses model melalui provider-neutral Model Runtime + ProviderDirectory, dengan
Vercel AI SDK adapters dan mock deterministik untuk development offline.

| Modul | Isi |
|---|---|
| `types.ts` | Legacy config/facade types plus result-bearing compatibility paths |
| `provider-directory.ts` | Immutable provider/model route and capability snapshots |
| `descriptor.ts` | Secret-free runtime descriptors and canonical fingerprints |
| `adapter.ts` | Provider-neutral adapter and invocation-result contracts |
| `model-runtime.ts` | Atomic `prepareCall()` and one-shot `PreparedModelCall` |
| `errors.ts` | Stable model-runtime error codes |
| `config.ts` | `DEFAULT_AGENT_CONFIG` (gpt-4o, t0.2, 2000 tok), `DEFAULT_ROUTER_CONFIG` (gpt-4o-mini, t0.0, 256 tok), `loadLLMConfig` (env `LLM_BASE_URL`/`LLM_API_KEY` global → kedua tier) |
| `client.ts` | `LLMClient` compatibility facade; retry/fallback orchestrates separate prepared calls |
| `mock.ts` | `MockLLMClient` and first-class deterministic `createMockModelRuntime()` |
| `index.ts` | `createLLMClient`, `createDefaultClients({ agent?, router? })` |

**Custom API provider** (`baseURL` + `apiKey` di `LLMModelConfig`):
dukung endpoint OpenAI-compatible apa pun — DeepSeek, OpenRouter, Groq,
Ollama/LM Studio lokal, vLLM. Logical provider route, adapter family, wire
protocol, and model identity remain distinct. `apiKey` stays private and is
not present in safe descriptors or runtime fingerprints. `apiKey` kosong → SDK
membaca `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.

`LLMClient` keeps the existing value-only methods while adding result-bearing
object/text and metadata-capable text-stream paths. A prepared call binds one
route/configuration snapshot and can be dispatched once; retries and fallbacks
prepare a new call. Custom Responses endpoints retain local JSON-only output
and Zod validation.

Catatan:
- AI SDK 5.0.250 mem-retry `APICallError` 429/5xx secara internal (dengan Retry-After); retry di LLMClient adalah lapisan kedua untuk error yang dibungkus — keduanya tidak boleh duplikat backoff.
- Breakpoint `cache_control` eksplisit (Anthropic) ditunda — SDK men-tipekan `system: string` saja. Lihat ARCHITECTURE.md → Deviations #1.
- Kontrak mock: string `"Intent Router"` / `"Bull Agent"` / `"Judge Agent"` harus tetap ada di prompt (`@harness/agent`).
- `generateText`/`generateObject` (AI SDK 5) memakai jalur non-streaming JSON (bukan SSE) — teruji oleh fake server OpenAI-compatible di `test/client.test.ts`.
