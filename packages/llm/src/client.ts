import { APICallError, generateObject, generateText, streamObject, streamText, zodSchema, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { randomUUID } from 'node:crypto';
import { sleep } from '@harness/shared';
import type { GenerateObjectParams, GenerateTextParams, LLMCallMetadata, LLMClientLike, LLMModelConfig, LLMResult, StreamObjectParams, StreamTextParams, SystemZones } from './types';

export interface LLMClientOptions {
  config: LLMModelConfig;
  /** Fallback providers — dicoba berurutan bila primary gagal setelah retry (P1.3). */
  fallbackConfigs?: LLMModelConfig[];
  /** Default 3. */
  maxRetries?: number;
  /** Delay dasar backoff eksponensial, ms (default 1000; kecilkan untuk test). */
  retryBaseDelayMs?: number;
  /** DI: override resolusi model (test). */
  modelFactory?: (config: LLMModelConfig) => LanguageModel;
}

/**
 * Buat instance provider dengan baseURL/apiKey eksplisit bila ada
 * (custom endpoint OpenAI-compatible: DeepSeek, OpenRouter, Ollama, dll).
 * Nilai undefined → SDK memakai default provider + env standar.
 */
export function createProvider(config: LLMModelConfig) {
  const options = { baseURL: config.baseURL, apiKey: config.apiKey };
  if (config.provider === 'anthropic') return createAnthropic(options);
  // Responses gateways can require session affinity even for an initial request.
  // This is an opaque client-lifetime ID, not another application's identity.
  const responses = config.api === 'responses' || !config.api && config.baseURL?.includes('opencode.ai/zen');
  const sessionId = responses ? config.sessionId ?? randomUUID() : undefined;
  return createOpenAI({ ...options, ...(sessionId ? { headers: {
    session_id: sessionId, 'x-client-request-id': sessionId, 'user-agent': 'finharness',
  } } : {}) });
}

/**
 * Resolusi provider → model (addendum §17).
 *
 * openai: memakai `.chat()` (chat completions) — protokol universal untuk
 * SEMUA endpoint OpenAI-compatible: native OpenAI, DeepSeek, OpenRouter,
 * Groq, Ollama/LM Studio, vLLM. (Call default provider memakai Responses API
 * yang hanya ada di OpenAI asli — tidak bisa dipakai untuk endpoint kustom.)
 * anthropic: `.chat()` = messages API (bentuk default Anthropic).
 */
export function resolveModel(config: LLMModelConfig): LanguageModel {
  const provider = createProvider(config);
  // opencode Zen pakai openai-responses, bukan chat-completions — seperti deepseek-harness LlmModelDiscoveryRequest.api
  const api = config.api ?? (config.baseURL?.includes('opencode.ai/zen') ? 'responses' : 'chat');
  if (api === 'responses') {
    // Vercel AI SDK: OpenAI Responses API (/responses) — untuk opencode Zen
    const openai = provider as unknown as { responses: (model: string) => LanguageModel; chat: (model: string) => LanguageModel };
    if (typeof openai.responses === 'function') return openai.responses(config.model);
  }
  return (provider as { chat: (model: string) => LanguageModel }).chat(config.model);
}

/**
 * Klasifikasi error LLM ke code retryable (addendum §21).
 * RATE_LIMIT / TIMEOUT / SERVER_ERROR → retry dengan backoff; sisanya langsung.
 */
export function classifyLLMError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof APICallError) {
    const status = error.statusCode;
    if (status === 429) return { code: 'RATE_LIMIT', retryable: true };
    if (status === 408) return { code: 'TIMEOUT', retryable: true };
    if (status !== undefined && status >= 500) return { code: 'SERVER_ERROR', retryable: true };
    return { code: `HTTP_${status ?? 'ERROR'}`, retryable: false };
  }
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as { code?: string }).code === 'ETIMEDOUT')
  ) {
    return { code: 'TIMEOUT', retryable: true };
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === 'RATE_LIMIT' || code === 'TIMEOUT' || code === 'SERVER_ERROR') {
    return { code, retryable: true };
  }
  return { code: 'NON_RETRYABLE', retryable: false };
}

/**
 * Bentuk ulang zona sistem prompt untuk AI SDK (addendum §17).
 * Urutan zona dipertahankan: [1] preamble + evidence block dulu, lalu
 * [2] persona agent — sehingga PREFIX (zona [1] + pemisah) byte-identical
 * antar agent dalam satu run dan masuk prompt cache provider (OpenAI:
 * automatic prefix caching).
 *
 * Catatan versi: AI SDK 5.0.x men-tipekan `system` sebagai `string` saja —
 * breakpoint `cache_control` eksplisit Anthropic (per-part providerOptions)
 * belum bisa dipasang. Zona tetap byte-identical; breakpoint Anthropic
 * menyusul saat upgrade AI SDK (lihat ARCHITECTURE.md · Deviations).
 */
export function toSystemPrompt(system: SystemZones | undefined, _provider: LLMModelConfig['provider']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system.join('\n');
}

/** Accept JSON-only replies while tolerating the common fenced wrapper. */
export function parseJsonResponse<T>(text: string, schema: GenerateObjectParams<T>['schema']): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  const candidate = first >= 0 && last >= first ? cleaned.slice(first, last + 1) : cleaned;
  return schema.parse(JSON.parse(candidate));
}

/** Custom Responses models may account hidden reasoning inside max_output_tokens. */
function responseTokenBudget(config: LLMModelConfig, structured: boolean): number {
  if (config.api === 'responses' && config.baseURL) return Math.max(config.maxTokens, structured ? 8192 : 4096);
  return config.maxTokens;
}

/**
 * Wrapper Vercel AI SDK (addendum Task 9): structured output (Zod),
 * temperature/maxTokens dari config dua-tier, retry backoff eksponensial.
 * P1.3: fallback array LanguageModel — idiom SDK yang sudah ter-install, tanpa gateway baru.
 */
export class LLMClient implements LLMClientLike {
  private readonly config: LLMModelConfig;
  private readonly configs: LLMModelConfig[];
  private readonly models: LanguageModel[];
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: LLMClientOptions) {
    this.config = { ...options.config, sessionId: options.config.sessionId ?? randomUUID() };
    const factory = options.modelFactory ?? resolveModel;
    const allConfigs = [this.config, ...(options.fallbackConfigs ?? []).map(c => ({ ...c, sessionId: c.sessionId ?? randomUUID() }))];
    this.configs = allConfigs;
    this.models = allConfigs.map((c) => factory(c));
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  /** Retry + fallback: iterasi models, di tiap model retry 3x untuk error retryable (P1.3).
   *  401/403/404 langsung break (salah config) tapi tetap coba model berikutnya. */
  private async withRetry<T>(fn: (model: LanguageModel, idx: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let m = 0; m < this.models.length; m++) {
      const model = this.models[m];
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        signal?.throwIfAborted();
        try {
          return await fn(model, m);
        } catch (error) {
          signal?.throwIfAborted();
          lastError = error;
          const status = (error as { statusCode?: number })?.statusCode;
          const isAuthOrNotFound = status === 401 || status === 403 || status === 404;
          if (isAuthOrNotFound) break; // coba model berikutnya, bukan retry model yang sama
          const { retryable } = classifyLLMError(error);
          if (!retryable) break;
          if (attempt < this.maxRetries - 1) await sleep(this.retryBaseDelayMs * 2 ** attempt);
          else break;
        }
      }
    }
    throw lastError;
  }

  async generateObjectResult<T>(params: GenerateObjectParams<T>): Promise<LLMResult<T>> {
    const started = performance.now();
    try {
      const completed = await this.withRetry(async (model, idx) => {
        const config = this.configs[idx];
        // Custom Responses gateways need not implement OpenAI json_schema.
        // Stream plain JSON and enforce the Zod contract locally.
        if (config.api === 'responses' && config.baseURL) {
          const schemaJson = JSON.stringify(zodSchema(params.schema).jsonSchema);
          const streamed = streamText({
            maxRetries: 0, model,
            prompt: `${params.prompt}\n\nReturn exactly one valid JSON object matching this JSON Schema. Do not use markdown or add commentary.\n${schemaJson}`,
            system: toSystemPrompt(params.system, config.provider),
            temperature: config.temperature, maxOutputTokens: responseTokenBudget(config, true),
            providerOptions: { openai: { store: false, promptCacheKey: config.sessionId! } },
          });
          for await (const part of streamed.fullStream) if (part.type === 'error') throw part.error;
          const [text, usage, finishReason] = await Promise.all([streamed.text, streamed.usage, streamed.finishReason]);
          return { result: { object: parseJsonResponse(text, params.schema), usage, finishReason }, config };
        }
        const request = {
          maxRetries: 0,
          model,
          schema: params.schema,
          prompt: params.prompt,
          system: toSystemPrompt(params.system, this.configs[idx ?? 0].provider),
          temperature: this.configs[idx ?? 0].temperature,
          maxOutputTokens: this.configs[idx ?? 0].maxTokens,
        };
        let result;
        if (this.configs[idx].api === 'responses') {
          let failure: unknown;
          const streamed = streamObject({ ...request,
            providerOptions: { openai: { store: false, promptCacheKey: this.configs[idx].sessionId! } },
            onError: event => { failure = event.error; },
          });
          try { result = { object: await streamed.object, usage: await streamed.usage, finishReason: await streamed.finishReason }; }
          catch (error) { throw failure ?? error; }
        } else result = await generateObject(request);
        return { result, config: this.configs[idx] };
      });
      return {
        value: completed.result.object as T,
        metadata: this.callMetadata(completed.config, completed.result.usage, completed.result.finishReason, performance.now() - started),
      };
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      const msg = error instanceof Error ? error.message : String(error);
      const isSchemaUnsupported = status === 400 && (msg.includes('response_format') || msg.includes('json_schema'));
      if (isSchemaUnsupported) {
        const completed = await this.withRetry(async (model, idx) => {
          const result = await generateText({
            maxRetries: 0,
            model,
            prompt: `${params.prompt}\n\nIMPORTANT: Respond with valid JSON only, no markdown fences, no explanation.`,
            system: toSystemPrompt(params.system, this.configs[idx ?? 0].provider),
            temperature: this.configs[idx ?? 0].temperature,
            maxOutputTokens: this.configs[idx ?? 0].maxTokens,
          });
          return { result, config: this.configs[idx] };
        });
        return {
          value: parseJsonResponse(completed.result.text, params.schema),
          metadata: this.callMetadata(completed.config, completed.result.usage, completed.result.finishReason, performance.now() - started),
        };
      }
      throw error;
    }
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    return (await this.generateObjectResult(params)).value;
  }

  private callMetadata(
    config: LLMModelConfig,
    usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number },
    finishReason: string | undefined,
    latencyMs: number,
  ): LLMCallMetadata {
    return {
      provider: config.provider,
      model: config.model,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      finishReason: finishReason ?? null,
      latencyMs,
    };
  }

  /**
   * Streams schema-shaped partials for public UI narration, then returns the
   * same provider-validated final object used by the agent pipeline.
   * Falls back to non-streaming generateObject if provider doesn't support
   * streaming structured output (common on free tiers like opencode free models
   * e.g. laguna-s-2.1-free returns 400 for streamObject but works for generateObject).
   */
  async streamObject<T>(params: StreamObjectParams<T>): Promise<T> {
    let lastError: unknown;
    for (let idx = 0; idx < this.models.length; idx++) {
      let emitted = false;
      let providerError: unknown;
      try {
        const result = streamObject({
          onError: event => { providerError = event.error; },
          model: this.models[idx],
          maxRetries: this.maxRetries - 1,
          schema: params.schema,
          prompt: params.prompt,
          system: toSystemPrompt(params.system, this.configs[idx].provider),
          temperature: this.configs[idx].temperature,
          maxOutputTokens: this.configs[idx].maxTokens,
          ...(this.configs[idx].api === 'responses' ? { providerOptions: { openai: { store: false, promptCacheKey: this.configs[idx].sessionId! } } } : {}),
        });
        void result.object.catch(() => undefined);
        for await (const partial of result.partialObjectStream) {
          emitted = true;
          params.onPartial?.(partial as Partial<T>);
        }
        return (await result.object) as T;
      } catch (error) {
        const actualError = providerError ?? error;
        lastError = actualError;
        const status = (actualError as { statusCode?: number })?.statusCode;
        const msg = actualError instanceof Error ? actualError.message : String(actualError);
        const isStreamingUnsupported = status === 400 && /stream|response_format|json_schema/i.test(msg);
        if (!emitted && isStreamingUnsupported) {
          // Fallback ke generateObject yang sudah handle fallback multi-model
          const output = await this.generateObject(params);
          params.onPartial?.(output as Partial<T>);
          return output;
        }
        // retryable/fallback: coba model berikutnya bila ada
        const { retryable } = classifyLLMError(actualError);
        const isAuthOrNotFound = status === 401 || status === 403 || status === 404;
        if ((retryable || isAuthOrNotFound) && idx < this.models.length - 1) continue;
        throw actualError;
      }
    }
    throw lastError;
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    const { text } = await this.withRetry(async (model, idx) => {
      const options = {
        maxRetries: 0,
        model,
        prompt: params.prompt,
        abortSignal: params.abortSignal,
        system: toSystemPrompt(params.system, this.configs[idx].provider),
        temperature: this.configs[idx].temperature,
        maxOutputTokens: responseTokenBudget(this.configs[idx], false),
      };
      if (this.configs[idx].api === 'responses' || !this.configs[idx].api && this.configs[idx].baseURL?.includes('opencode.ai/zen')) {
        const response = streamText({ ...options, providerOptions: { openai: { store: false, promptCacheKey: this.configs[idx].sessionId! } }, onError: () => {} });
        for await (const part of response.fullStream) if (part.type === 'error') throw part.error;
        return { text: await response.text };
      }
      return generateText(options);
    }, params.abortSignal,
    );
    return text;
  }

  /**
   * Streaming text token-per-token (Phase 2 Task 2). Memakai Vercel `streamText`
   * dan mengembalikan `textStream` (AsyncIterable<string>). KONSUMEN harus
   * mengiterasi sampai habis; konsumen boleh berhenti lebih awal (→ abort).
   *
   * Sengaja TIDAK dibungkus `withRetry`: stream tak bisa di-retry di tengah
   * jalan; kalau error terjadi di tengah stream, error tersampaikan ke iterator.
   * `maxTokens` tetap 2000/256 (tidak menambah biaya token).
   */
  streamText(params: StreamTextParams): AsyncIterable<string> {
    const result = streamText({
      model: this.models[0],
      prompt: params.prompt,
      system: toSystemPrompt(params.system, this.config.provider),
      temperature: this.config.temperature,
      maxOutputTokens: this.config.maxTokens,
    });
    return result.textStream;
  }
}
