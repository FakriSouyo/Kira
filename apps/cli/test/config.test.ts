import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const SAVED_ENV = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!SAVED_ENV.has(name)) SAVED_ENV.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of SAVED_ENV) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  SAVED_ENV.clear();
});

describe('loadConfig (addendum §12)', () => {
  it('defaults: home ~/.finharness, dua-tier LLM, cache 24h, mock off', () => {
    const config = loadConfig({ homeDir: '/tmp/never-created' });
    expect(config.llm.agent.model).toBe('gpt-4o');
    expect(config.llm.agent.maxTokens).toBe(2000);
    expect(config.llm.router.model).toBe('gpt-4o-mini');
    expect(config.llm.router.maxTokens).toBe(256);
    expect(config.sectors.cacheTtlHours).toBe(24);
    expect(config.sectors.mock).toBe(false);
    expect(config.mockLlm).toBe(false);
  });

  it('env overrides win over defaults', () => {
    setEnv('LLM_MODEL', 'gpt-4.1');
    setEnv('LLM_PROVIDER', 'anthropic');
    setEnv('LLM_ROUTER_MODEL', 'gpt-4o-nano');
    setEnv('FINHARNESS_MOCK_LLM', 'true');

    const config = loadConfig({ homeDir: '/tmp/never-created' });
    expect(config.llm.agent.model).toBe('gpt-4.1');
    expect(config.llm.agent.provider).toBe('anthropic');
    expect(config.llm.router.model).toBe('gpt-4o-nano');
    // router provider mengikuti provider agent (addendum §17)
    expect(config.llm.router.provider).toBe('anthropic');
    expect(config.mockLlm).toBe(true);
  });

  it('config.json fills in what env does not specify', () => {
    const home = mkdtempSync(join(tmpdir(), 'finharness-cfg-'));
    try {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({
          llm: { agent: { model: 'claude-3-5-sonnet', provider: 'anthropic', maxTokens: 4096 } },
          sectors_api: { key: 'sk-file', base_url: 'http://localhost:8080/v1', cache_ttl_hours: 6 },
          features: { mock_mode: true },
        }),
      );

      const config = loadConfig({ homeDir: home });
      expect(config.llm.agent.model).toBe('claude-3-5-sonnet');
      expect(config.llm.agent.provider).toBe('anthropic');
      expect(config.llm.agent.maxTokens).toBe(4096);
      expect(config.sectors.apiKey).toBe('sk-file');
      expect(config.sectors.baseUrl).toBe('http://localhost:8080/v1');
      expect(config.sectors.cacheTtlHours).toBe(6);
      expect(config.sectors.mock).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('env beats config.json for the same field', () => {
    const home = mkdtempSync(join(tmpdir(), 'finharness-cfg-'));
    try {
      writeFileSync(join(home, 'config.json'), JSON.stringify({ llm: { agent: { model: 'from-file' } } }));
      setEnv('LLM_MODEL', 'from-env');

      const config = loadConfig({ homeDir: home });
      expect(config.llm.agent.model).toBe('from-env');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('corrupt config.json is ignored gracefully', () => {
    const home = mkdtempSync(join(tmpdir(), 'finharness-cfg-'));
    try {
      writeFileSync(join(home, 'config.json'), '{not json');
      const config = loadConfig({ homeDir: home });
      expect(config.llm.agent.model).toBe('gpt-4o');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('config.json per-tier base_url/api_key + env beats file', () => {
    const home = mkdtempSync(join(tmpdir(), 'finharness-cfg-'));
    try {
      writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({
          llm: {
            agent: {
              provider: 'openai',
              model: 'deepseek-chat',
              base_url: 'https://api.deepseek.com/v1',
              api_key: 'sk-agent',
            },
            router: { base_url: 'http://localhost:11434/v1', api_key: 'ollama' },
          },
        }),
      );

      const config = loadConfig({ homeDir: home });
      expect(config.llm.agent.baseURL).toBe('https://api.deepseek.com/v1');
      expect(config.llm.agent.apiKey).toBe('sk-agent');
      expect(config.llm.router.baseURL).toBe('http://localhost:11434/v1');
      expect(config.llm.router.apiKey).toBe('ollama');

      setEnv('LLM_BASE_URL', 'https://env-wins.local/v1');
      setEnv('LLM_API_KEY', 'env-key');
      const overridden = loadConfig({ homeDir: home });
      expect(overridden.llm.agent.baseURL).toBe('https://env-wins.local/v1');
      expect(overridden.llm.agent.apiKey).toBe('env-key');
      expect(overridden.llm.router.baseURL).toBe('https://env-wins.local/v1');
      expect(overridden.llm.router.apiKey).toBe('env-key');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('CLI overrides (mock flags) beat env', () => {
    setEnv('FINHARNESS_MOCK_SECTORS', 'false');
    const config = loadConfig({ homeDir: '/tmp/never-created', mockSectors: true, mockLlm: true });
    expect(config.sectors.mock).toBe(true);
    expect(config.mockLlm).toBe(true);
  });
});
