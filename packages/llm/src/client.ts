import { APICallError, generateObject, generateText, type LanguageModel } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { openai } from '@ai-sdk/openai';
import { sleep } from '@harness/shared';
import type { GenerateObjectParams, GenerateTextParams, LLMClientLike, LLMModelConfig, SystemZones } from './types';

export interface LLMClientOptions {
  config: LLMModelConfig;
  /** Default 3. */
  maxRetries?: number;
  /** Delay dasar backoff eksponensial, ms (default 1000; kecilkan untuk test). */
  retryBaseDelayMs?: number;
  /** DI: override resolusi model (test). */
  modelFactory?: (config: LLMModelConfig) => LanguageModel;
}

/** Resolusi provider → model (addendum §17). */
export function resolveModel(config: LLMModelConfig): LanguageModel {
  if (config.provider === 'anthropic') return anthropic(config.model);
  return openai(config.model);
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

/**
 * Wrapper Vercel AI SDK (addendum Task 9): structured output (Zod),
 * temperature/maxTokens dari config dua-tier, retry backoff eksponensial.
 */
export class LLMClient implements LLMClientLike {
  private readonly config: LLMModelConfig;
  private readonly model: LanguageModel;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: LLMClientOptions) {
    this.config = options.config;
    this.model = (options.modelFactory ?? resolveModel)(options.config);
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    const { object } = await this.withRetry(() =>
      generateObject({
        model: this.model,
        schema: params.schema,
        prompt: params.prompt,
        system: toSystemPrompt(params.system, this.config.provider),
        temperature: this.config.temperature,
        // AI SDK 5: parameter biaya-output bernama maxOutputTokens
        maxOutputTokens: this.config.maxTokens,
      }),
    );
    return object;
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    const { text } = await this.withRetry(() =>
      generateText({
        model: this.model,
        prompt: params.prompt,
        system: toSystemPrompt(params.system, this.config.provider),
        temperature: this.config.temperature,
        // AI SDK 5: parameter biaya-output bernama maxOutputTokens
        maxOutputTokens: this.config.maxTokens,
      }),
    );
    return text;
  }

  /** Retry dengan backoff eksponensial hanya untuk error retryable (addendum §21). */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        const { retryable } = classifyLLMError(error);
        if (!retryable || attempt >= this.maxRetries - 1) throw error;
        await sleep(this.retryBaseDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }
}
