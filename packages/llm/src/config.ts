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
 * Resolusi konfigurasi dua-tier dari environment (addendum §17):
 * router provider mengikuti provider agent bila belum eksplisit.
 */
export function loadLLMConfig(env: EnvLike = process.env): { agent: LLMModelConfig; router: LLMModelConfig } {
  const agent: LLMModelConfig = {
    ...DEFAULT_AGENT_CONFIG,
    provider: pickProvider(env[ENV.llmProvider]),
    model: env[ENV.llmModel] ?? DEFAULT_AGENT_CONFIG.model,
  };
  const router: LLMModelConfig = {
    ...DEFAULT_ROUTER_CONFIG,
    provider: pickProvider(env[ENV.llmRouterProvider] ?? env[ENV.llmProvider]),
    model: env[ENV.llmRouterModel] ?? DEFAULT_ROUTER_CONFIG.model,
  };
  return { agent, router };
}
