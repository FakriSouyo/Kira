import type { z } from 'zod';

/**
 * Konfigurasi model eksplisit (addendum §17, dua-tier locked):
 * Tier 1 — agent berat (Bull/Judge): model flagship + maxTokens 2000
 * Tier 2 — router ringan (Intent Router): model kecil + maxTokens 256
 */
export interface LLMModelConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  temperature: number;
  /** Batas output per panggilan — kontrol biaya (addendum §17). */
  maxTokens: number;
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
}

export interface GenerateTextParams {
  prompt: string;
  system?: SystemZones;
}

/** Parameter streaming jalur text (Phase 2 Task 2) — klaim/judgment tetap generateObject. */
export interface StreamTextParams {
  prompt: string;
  system?: SystemZones;
}

/**
 * Permukaan umum client LLM — diimplementasikan LLMClient (provider nyata)
 * dan MockLLMClient (offline, deterministik). Agent hanya bergantung ke sini.
 */
export interface LLMClientLike {
  generateObject<T>(params: GenerateObjectParams<T>): Promise<T>;
  generateText(params: GenerateTextParams): Promise<string>;
  /**
   * Streaming text token-per-token (jalur narasi/REPL). Bukan untuk klaim/
   * judgment terstruktur — itu tetap `generateObject`. Return AsyncIterable
   * sepenggal teks; konsumen harus iterasi sampai habis (stream tak bisa
   * di-retry tengah jalan).
   */
  streamText(params: StreamTextParams): AsyncIterable<string>;
}
