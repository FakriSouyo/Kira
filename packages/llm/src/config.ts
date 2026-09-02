import { ENV } from '@harness/shared';
import type { LLMModelConfig } from './types';

/** Default dua-tier (addendum §17). */
export const DEFAULT_AGENT_CONFIG: LLMModelConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  temperature: 0.2,
  maxTokens: 2000,
};

export const DEFAULT_ROUTER_CONFIG: LLMModelConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0.0,
  maxTokens: 256,
};

type EnvLike = Record<string, string | undefined>;

function pickProvider(value: string | undefined): LLMModelConfig['provider'] {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}

/**
 * Nilai kustom provider yang di-set global (kedua tier):
 * LLM_BASE_URL / LLM_API_KEY. Bila tidak ada di env, tidak masuk ke config
 * sehingga SDK memakai endpoint default provider + env standar
 * (OPENAI_API_KEY / ANTHROPIC_API_KEY).
 */
function customProviderEnv(env: EnvLike): Pick<LLMModelConfig, 'baseURL' | 'apiKey'> {
  const out: Partial<Pick<LLMModelConfig, 'baseURL' | 'apiKey'>> = {};
  if (env[ENV.llmBaseUrl] !== undefined) out.baseURL = env[ENV.llmBaseUrl];
  if (env[ENV.llmApiKey] !== undefined) out.apiKey = env[ENV.llmApiKey];
  return out;
}

/**
 * Resolusi konfigurasi dua-tier dari environment (addendum §17):
 * router provider mengikuti provider agent bila belum eksplisit;
 * baseURL/apiKey global berlaku untuk kedua tier.
 */
export function loadLLMConfig(env: EnvLike = process.env): { agent: LLMModelConfig; router: LLMModelConfig } {
  const custom = customProviderEnv(env);
  const agent: LLMModelConfig = {
    ...DEFAULT_AGENT_CONFIG,
    ...custom,
    provider: pickProvider(env[ENV.llmProvider]),
    model: env[ENV.llmModel] ?? DEFAULT_AGENT_CONFIG.model,
  };
  const router: LLMModelConfig = {
    ...DEFAULT_ROUTER_CONFIG,
    ...custom,
    provider: pickProvider(env[ENV.llmRouterProvider] ?? env[ENV.llmProvider]),
    model: env[ENV.llmRouterModel] ?? DEFAULT_ROUTER_CONFIG.model,
  };
  return { agent, router };
}
