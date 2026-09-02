import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_CONFIG, DEFAULT_ROUTER_CONFIG, loadLLMConfig } from '../src/index';

describe('loadLLMConfig (dua-tier, addendum §17)', () => {
  it('returns the locked defaults when env is empty', () => {
    const config = loadLLMConfig({});
    expect(config.agent).toEqual(DEFAULT_AGENT_CONFIG);
    expect(config.router).toEqual(DEFAULT_ROUTER_CONFIG);
  });

  it('applies agent provider/model overrides from env', () => {
    const config = loadLLMConfig({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-3-5-sonnet' });
    expect(config.agent.provider).toBe('anthropic');
    expect(config.agent.model).toBe('claude-3-5-sonnet');
  });

  it('applies router overrides when present', () => {
    const config = loadLLMConfig({ LLM_ROUTER_MODEL: 'gpt-4o-nano', LLM_ROUTER_PROVIDER: 'anthropic' });
    expect(config.router.model).toBe('gpt-4o-nano');
    expect(config.router.provider).toBe('anthropic');
  });

  it('router provider falls back to the agent provider', () => {
    const config = loadLLMConfig({ LLM_PROVIDER: 'anthropic' });
    expect(config.router.provider).toBe('anthropic');
    expect(config.router.model).toBe(DEFAULT_ROUTER_CONFIG.model);
  });

  it('keeps temperature & maxTokens at the locked defaults', () => {
    const config = loadLLMConfig({ LLM_MODEL: 'x' });
    expect(config.agent.temperature).toBe(0.2);
    expect(config.agent.maxTokens).toBe(2000);
    expect(config.router.temperature).toBe(0.0);
    expect(config.router.maxTokens).toBe(256);
  });
});
