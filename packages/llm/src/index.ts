export * from './types';
export * from './config';
export * from './client';
export * from './mock';

import { DEFAULT_AGENT_CONFIG, DEFAULT_ROUTER_CONFIG } from './config';
import { LLMClient, type LLMClientOptions } from './client';
import { MockLLMClient } from './mock';
import type { LLMClientLike, LLMModelConfig } from './types';

/** Factory dua-tier: satu client per tier; `mock: true` → MockLLMClient offline. */
export function createLLMClient(
  config: LLMModelConfig,
  options: { mock?: boolean; maxRetries?: number; retryBaseDelayMs?: number; modelFactory?: LLMClientOptions['modelFactory'] } = {},
): LLMClientLike {
  if (options.mock) return new MockLLMClient();
  return new LLMClient({ config, maxRetries: options.maxRetries, retryBaseDelayMs: options.retryBaseDelayMs, modelFactory: options.modelFactory });
}

/** Shortcut untuk tier default (bagi pemakai yang tidak membangun konteks penuh). */
export function createDefaultClients(mocks: { agent?: boolean; router?: boolean } = {}): {
  agent: LLMClientLike;
  router: LLMClientLike;
} {
  return {
    agent: createLLMClient(DEFAULT_AGENT_CONFIG, { mock: mocks.agent }),
    router: createLLMClient(DEFAULT_ROUTER_CONFIG, { mock: mocks.router }),
  };
}
