import type { LLMModelConfig } from '@harness/llm';
import { DEFAULT_AGENT_CONFIG, DEFAULT_ROUTER_CONFIG } from '@harness/llm';

/**
 * Provider registry — single source of truth for wizard UI (Phase 9B).
 * Friendly names → internal model IDs; baseURL defaults per provider.
 * Do not hardcode elsewhere — inspect this file for provider list.
 */

export type ProviderId = 'bitdeer' | 'openai' | 'anthropic' | 'openrouter' | 'custom';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  baseURL?: string; // undefined = provider default
  provider: LLMModelConfig['provider']; // underlying SDK: openai|anthropic
  models: Array<{ id: string; label: string }>;
  docUrl?: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: 'bitdeer',
    label: 'Bitdeer',
    baseURL: 'https://api-inference.bitdeer.ai/v1',
    provider: 'openai',
    models: [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash' },
      { id: 'Qwen/Qwen3-30B-A3B', label: 'Qwen3 30B' },
    ],
    docUrl: 'https://api-inference.bitdeer.ai',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    ],
    docUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    models: [
      { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
    ],
    docUrl: 'https://console.anthropic.com/',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    provider: 'openai',
    models: [
      { id: 'openai/gpt-4o', label: 'GPT-4o (via OpenRouter)' },
      { id: 'anthropic/claude-3.5-sonnet', label: 'Claude 3.5 Sonnet (via OpenRouter)' },
    ],
    docUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    provider: 'openai',
    models: [
      { id: DEFAULT_AGENT_CONFIG.model, label: `Custom (${DEFAULT_AGENT_CONFIG.model})` },
      { id: DEFAULT_ROUTER_CONFIG.model, label: `Custom (${DEFAULT_ROUTER_CONFIG.model})` },
    ],
  },
];

export function getProvider(id: ProviderId): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function modelLabel(providerId: ProviderId, modelId: string): string {
  const p = getProvider(providerId);
  return p?.models.find((m) => m.id === modelId)?.label ?? modelId;
}

export const SECTORS_DOC_URL = 'https://api.sectors.app';
export const SECTORS_KEY_HINT = 'Where do I get this? → https://api.sectors.app (API Key)';
