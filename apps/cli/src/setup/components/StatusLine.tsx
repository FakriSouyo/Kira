import type { FinharnessConfig } from '../../config';
import { getProvider } from '../providers';

export function statusLine(config: FinharnessConfig): string {
  const provider = getProvider(
    (config.llm.agent.baseURL?.includes('bitdeer') ? 'bitdeer' : config.llm.agent.provider === 'anthropic' ? 'anthropic' : 'openai') as never,
  );
  const modelLabel = provider?.models.find((m) => m.id === config.llm.agent.model)?.label ?? config.llm.agent.model;
  const provLabel = provider?.label ?? config.llm.agent.provider;
  return `Ready · ${provLabel} · ${modelLabel}`;
}
