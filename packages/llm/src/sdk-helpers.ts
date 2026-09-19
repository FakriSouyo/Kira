import type { GenerateObjectParams, LLMModelConfig, SystemZones } from './types';

export function toSystemPrompt(system: SystemZones | undefined, _provider: LLMModelConfig['provider']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system.join('\n');
}

export function parseJsonResponse<T>(text: string, schema: GenerateObjectParams<T>['schema']): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  const candidate = first >= 0 && last >= first ? cleaned.slice(first, last + 1) : cleaned;
  return schema.parse(JSON.parse(candidate));
}

export function responseTokenBudget(config: LLMModelConfig, structured: boolean): number {
  if (config.api === 'responses' && config.baseURL) return Math.max(config.maxTokens, structured ? 8192 : 4096);
  return config.maxTokens;
}
