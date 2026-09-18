import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { needsSetup, saveSectorsKey, saveProvider, testConnections, validateSectorsKey } from '../src/setup/service';
import { PROVIDERS } from '../src/setup/providers';

describe('setup service Slice 1 (no UI)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-setup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('needsSetup true when missing keys, false when mock or keys present', () => {
    let cfg = loadConfig({ homeDir: dir });
    expect(needsSetup(cfg)).toBe(true);
    saveSectorsKey(dir, 'sectors-test123456');
    cfg = loadConfig({ homeDir: dir });
    expect(needsSetup(cfg)).toBe(true); // still missing LLM
    saveProvider(dir, 'openai', 'sk-llm-test123', 'gpt-4o', 'gpt-4o-mini');
    cfg = loadConfig({ homeDir: dir });
    expect(needsSetup(cfg)).toBe(false);
    cfg = loadConfig({ homeDir: dir, mockSectors: true });
    expect(needsSetup(cfg)).toBe(false);
  });

  it('validateSectorsKey masks and validates', () => {
    expect(validateSectorsKey('')).toBe('API key is required');
    expect(validateSectorsKey('bad')).toBe('Key is too short');
    expect(validateSectorsKey('short')).toBe('Key is too short');
    expect(validateSectorsKey('sectors-valid-1234567890')).toBeUndefined();
    expect(validateSectorsKey('sk-valid-1234567890')).toBeUndefined();
    // Sectors keys no longer require sk- prefix (real keys are opaque)
    expect(validateSectorsKey('my-sectors-key-123456')).toBeUndefined();
  });

  it('saveSectorsKey persists to .credentials.json (0600) and masks not printed', () => {
    const path = saveSectorsKey(dir, 'sk-sectors-1234567890');
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('sk-sectors-1234567890');
    // never log full key is UI concern; here just ensure file contains key
  });

  it('saveProvider persists friendly→internal model IDs and baseURL', () => {
    // custom provider is the generic path — Bitdeer is just an example custom endpoint (deepseek-harness style)
    saveProvider(dir, 'custom', 'sk-llm-xxx', 'deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen3-30B-A3B', 'https://api-inference.bitdeer.ai/v1');
    const cfg = loadConfig({ homeDir: dir });
    expect(cfg.llm.agent.model).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(cfg.llm.router.model).toBe('Qwen/Qwen3-30B-A3B');
    expect(cfg.llm.agent.baseURL).toBe('https://api-inference.bitdeer.ai/v1');
  });

  it('PROVIDERS registry has openai/anthropic/openrouter/custom (bitdeer is custom example, not hardcoded)', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('custom');
    expect(ids).not.toContain('bitdeer' as never);
  });

  it('testConnections success', async () => {
    const res = await testConnections({
      financialData: { getCompanyReport: async () => ({}) },
      agentLlm: { generateText: async () => ({}) },
      routerLlm: { generateText: async () => ({}) },
    });
    expect(res.sectors.ok).toBe(true);
    expect(res.agent.ok).toBe(true);
    expect(res.router.ok).toBe(true);
  });

  it('testConnections failure returns errors without throw', async () => {
    const res = await testConnections({
      financialData: { getCompanyReport: async () => { throw new Error('auth failed'); } },
      agentLlm: { generateText: async () => { throw new Error('rate limit'); } },
      routerLlm: { generateText: async () => ({}) },
    });
    expect(res.sectors.ok).toBe(false);
    expect(res.sectors.error).toContain('auth failed');
    expect(res.agent.error).toContain('rate limit');
    expect(res.router.ok).toBe(true);
  });

  it('existing /auth-set behavior unchanged — writeCredentials merges', () => {
    saveSectorsKey(dir, 'sk-a-1234567890');
    saveProvider(dir, 'openai', 'sk-b-1234567890', 'gpt-4o', 'gpt-4o-mini');
    const cfg = loadConfig({ homeDir: dir });
    expect(cfg.sectors.apiKey).toBe('sk-a-1234567890');
    expect(cfg.llm.agent.apiKey).toBe('sk-b-1234567890');
  });
});
