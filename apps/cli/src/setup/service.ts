import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeCredentialsFile, loadConfig } from '../config';
import { getProvider, type ProviderId } from './providers';
import type { FinharnessConfig } from '../config';

/**
 * Setup service — pure config persistence + first-run detection (Phase 9B Slice 1).
 * Reuses existing credential/config mechanisms, no new storage.
 */

export function needsSetup(config: FinharnessConfig): boolean {
  // Scriptable bypass: mock mode or CI/non-TTY handled in index.ts gate; here only check missing keys
  if (config.sectors.mock || config.mockLlm) return false;
  const missingSectors = !config.sectors.apiKey;
  const missingLlm = !config.llm.agent.apiKey && !config.llm.router.apiKey;
  return missingSectors || missingLlm;
}

export function isSectorsConfigured(config: FinharnessConfig): boolean {
  return Boolean(config.sectors.apiKey);
}

export function isLlmConfigured(config: FinharnessConfig): boolean {
  return Boolean(config.llm.agent.apiKey || config.llm.router.apiKey);
}

export function validateSectorsKey(key: string): string | undefined {
  if (!key.trim()) return 'API key is required';
  if (key.trim().length < 8) return 'Key is too short';
  // Sectors API keys are opaque tokens — do not enforce sk- prefix (fix: user reports real keys don't start with sk-)
  return undefined;
}

export function saveSectorsKey(homeDir: string, key: string): string {
  const err = validateSectorsKey(key);
  if (err) throw new Error(err);
  return writeCredentialsFile(homeDir, { sectors_api: { key: key.trim() } });
}

export function saveProvider(
  homeDir: string,
  providerId: ProviderId,
  apiKey: string,
  agentModelId: string,
  routerModelId: string,
  customBaseUrl?: string,
): string {
  if (!apiKey.trim()) throw new Error('API key is required');
  const spec = getProvider(providerId);
  if (!spec) throw new Error(`Unknown provider ${providerId}`);
  const baseURL = customBaseUrl ?? spec.baseURL;

  // 1) secrets → .credentials.json (agent+router same key for normal user)
  const credPath = writeCredentialsFile(homeDir, {
    llm: { agent: { api_key: apiKey.trim() }, router: { api_key: apiKey.trim() } },
  });

  // 2) non-secrets → config.json (provider, model, base_url)
  const configPath = join(homeDir, 'config.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const llm = (existing.llm ?? {}) as Record<string, unknown>;
  const agent = (llm.agent ?? {}) as Record<string, unknown>;
  const router = (llm.router ?? {}) as Record<string, unknown>;
  (existing as Record<string, unknown>).llm = {
    ...llm,
    agent: { ...agent, provider: spec.provider, model: agentModelId, ...(baseURL ? { base_url: baseURL } : {}) },
    router: { ...router, provider: spec.provider, model: routerModelId, ...(baseURL ? { base_url: baseURL } : {}) },
  };
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

  return credPath;
}

export function loadFreshConfig(homeDir?: string): FinharnessConfig {
  return loadConfig({ homeDir });
}

export interface ConnectionResult {
  sectors: { ok: boolean; error?: string };
  agent: { ok: boolean; error?: string };
  router: { ok: boolean; error?: string };
}

/**
 * Test connections — calls sectors.getCompanyReport + llm.generateText for both tiers.
 * Passed impls are injected for testability; on failure returns error strings, no throws.
 */
export async function testConnections(deps: {
  sectors: { getCompanyReport: (ticker: string) => Promise<unknown> };
  agentLlm: { generateText: (p: { prompt: string }) => Promise<unknown> };
  routerLlm: { generateText: (p: { prompt: string }) => Promise<unknown> };
}): Promise<ConnectionResult> {
  const out: ConnectionResult = {
    sectors: { ok: false },
    agent: { ok: false },
    router: { ok: false },
  };
  try {
    await deps.sectors.getCompanyReport('BBCA');
    out.sectors.ok = true;
  } catch (e) {
    out.sectors.error = e instanceof Error ? e.message : String(e);
  }
  try {
    await deps.agentLlm.generateText({ prompt: 'test' });
    out.agent.ok = true;
  } catch (e) {
    out.agent.error = e instanceof Error ? e.message : String(e);
  }
  try {
    await deps.routerLlm.generateText({ prompt: 'test' });
    out.router.ok = true;
  } catch (e) {
    out.router.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}
