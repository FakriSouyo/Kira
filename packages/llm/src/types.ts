import type { z } from 'zod';

/**
 * Konfigurasi model eksplisit (addendum §17, dua-tier locked):
 * Tier 1 — agent berat (Bull/Judge): model flagship + maxTokens 2000
 * Tier 2 — router ringan (Intent Router): model kecil + maxTokens 256
 */
export interface LLMModelConfig {
  /** Stable logical provider identity; distinct from the transport family. */
  providerId?: string;
  /** Opaque runtime session affinity for Responses gateways; never part of prompts. */
  sessionId?: string;
  provider: 'openai' | 'anthropic';
  model: string;
  temperature: number;
  /** Batas output per panggilan — kontrol biaya (addendum §17). */
  maxTokens: number;
  /** Conservative input context window used by the local budget policy. */
  contextWindowTokens?: number;
  /**
   * Endpoint kustom (OpenAI-compatible: DeepSeek, OpenRouter, Groq,
   * Ollama/LM Studio lokal, dll). `undefined` = endpoint default provider.
   */
  baseURL?: string;
  /**
   * API key eksplisit. `undefined` = env standar SDK
   * (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`).
   */
  apiKey?: string;
  /**
   * Wire protocol untuk endpoint kustom — seperti di deepseek-harness
   * `LlmModelDiscoveryRequest.api`. `chat` = /chat/completions (default),
   * `responses` = /responses (opencode Zen, OpenAI Responses API).
   */
  api?: 'chat' | 'responses';
}

/**
 * Sistem prompt dua zona (addendum §17 · Token & Cache Strategy):
 *   [0] = zona [1]: preamble + evidence block — HARUS byte-identical antar
 *       agent dalam satu run agar prefix masuk prompt cache provider;
 *   [1] = zona [2]: persona & instruksi spesifik agent.
 * String tunggal = satu zona saja.
 */
export type SystemZones = string | string[];

export interface GenerateObjectParams<T> {
  schema: z.ZodType<T>;
  prompt: string;
  system?: SystemZones;
  abortSignal?: AbortSignal;
}

/** Structured generation with optional public partial-object updates. */
export interface StreamObjectParams<T> extends GenerateObjectParams<T> {
  onPartial?: (partial: Partial<T>) => void;
}

export interface GenerateTextParams {
  prompt: string;
  system?: SystemZones;
  /** Caller-owned cancellation; abort prevents subsequent retries/fallbacks. */
  abortSignal?: AbortSignal;
}

/** Provider facts attached to one successful model call. Missing usage stays null. */
export interface LLMCallMetadata {
  provider: LLMModelConfig['provider'] | 'mock';
  model: string;
  /** Q1 runtime identity; legacy provider/model remain for compatibility. */
  providerId?: string;
  modelId?: string;
  adapterId?: string;
  protocol?: string;
  runtimeFingerprint?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  latencyMs: number;
}

export interface LLMResult<T> {
  value: T;
  metadata: LLMCallMetadata;
}

export interface LLMTextStreamResult {
  chunks: AsyncIterable<string>;
  metadata: Promise<LLMCallMetadata>;
}

/** Parameter streaming jalur text (Phase 2 Task 2) — klaim/judgment tetap generateObject. */
export interface StreamTextParams {
  prompt: string;
  system?: SystemZones;
  abortSignal?: AbortSignal;
}

/**
 * Permukaan umum client LLM — diimplementasikan LLMClient (provider nyata)
 * dan MockLLMClient (offline, deterministik). Agent hanya bergantung ke sini.
 */
export interface LLMClientLike {
  /** Pure semantic runtime snapshot when supplied by the production client. */
  describeRuntimePlan?(): import('./plan').ModelRuntimePlan;
  generateObject<T>(params: GenerateObjectParams<T>): Promise<T>;
  /** Transitional usage-aware API; command subagents migrate before legacy value-only methods are removed. */
  generateObjectResult?<T>(params: GenerateObjectParams<T>): Promise<LLMResult<T>>;
  /** Q1 result-bearing text compatibility path. */
  generateTextResult?(params: GenerateTextParams): Promise<LLMResult<string>>;
  streamObject<T>(params: StreamObjectParams<T>): Promise<T>;
  generateText(params: GenerateTextParams): Promise<string>;
  /**
   * Streaming text token-per-token (jalur narasi/REPL). Bukan untuk klaim/
   * judgment terstruktur — itu tetap `generateObject`. Return AsyncIterable
   * sepenggal teks; konsumen harus iterasi sampai habis (stream tak bisa
   * di-retry tengah jalan).
   */
  streamText(params: StreamTextParams): AsyncIterable<string>;
  /** Q1 metadata-capable stream compatibility path. */
  streamTextResult?(params: StreamTextParams): LLMTextStreamResult;
}
