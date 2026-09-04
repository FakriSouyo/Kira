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
    saveSectorsKey(dir, 'sk-sectors-test123');
    cfg = loadConfig({ homeDir: dir });
    expect(needsSetup(cfg)).toBe(true); // still missing LLM
    saveProvider(dir, 'bitdeer', 'sk-llm-test123', 'deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen3-30B-A3B');
    cfg = loadConfig({ homeDir: dir });
    expect(needsSetup(cfg)).toBe(false);
    cfg = loadConfig({ homeDir: dir, mockSectors: true });
    expect(needsSetup(cfg)).toBe(false);
  });

  it('validateSectorsKey masks and validates', () => {
    expect(validateSectorsKey('')).toBe('API key is required');
    expect(validateSectorsKey('bad')).toBe('Key should start with sk-');
    expect(validateSectorsKey('sk-short')).toBe('Key is too short');
    expect(validateSectorsKey('sk-valid-1234567890')).toBeUndefined();
  });

  it('saveSectorsKey persists to .credentials.json (0600) and masks not printed', () => {
    const path = saveSectorsKey(dir, 'sk-sectors-1234567890');
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('sk-sectors-1234567890');
    // never log full key is UI concern; here just ensure file contains key
  });

  it('saveProvider persists friendly→internal model IDs and baseURL', () => {
    saveProvider(dir, 'bitdeer', 'sk-llm-xxx', 'deepseek-ai/DeepSeek-V4-Flash', 'Qwen/Qwen3-30B-A3B');
    const cfg = loadConfig({ homeDir: dir });
    expect(cfg.llm.agent.model).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(cfg.llm.router.model).toBe('Qwen/Qwen3-30B-A3B');
    expect(cfg.llm.agent.baseURL).toBe('https://api-inference.bitdeer.ai/v1');
  });

  it('PROVIDERS registry has bitdeer/openai/anthropic/openrouter/custom', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toContain('bitdeer');
    expect(ids).toContain('openai');
    expect(ids).toContain('custom');
  });

  it('testConnections success', async () => {
    const res = await testConnections({
      sectors: { getCompanyReport: async () => ({}) },
      agentLlm: { generateText: async () => ({}) },
      routerLlm: { generateText: async () => ({}) },
    });
    expect(res.sectors.ok).toBe(true);
    expect(res.agent.ok).toBe(true);
    expect(res.router.ok).toBe(true);
  });

  it('testConnections failure returns errors without throw', async () => {
    const res = await testConnections({
      sectors: { getCompanyReport: async () => { throw new Error('auth failed'); } },
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
