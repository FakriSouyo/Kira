import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_NAME, ENV } from '@harness/shared';
import type { LLMModelConfig } from '@harness/llm';
import { DEFAULT_AGENT_CONFIG, DEFAULT_ROUTER_CONFIG } from '@harness/llm';

/** Bentuk model LLM di file konfigurasi (snake_case, konsisten dengan sectors_api). */
interface LLMModelFile {
  provider?: LLMModelConfig['provider'];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Endpoint kustom (DeepSeek/OpenRouter/Ollama...); kosong = default provider. */
  base_url?: string;
  api_key?: string;
}

/** Bentuk file konfigurasi user (addendum §12 · config.json). */
interface ConfigFile {
  llm?: {
    agent?: LLMModelFile;
    router?: LLMModelFile;
  };
  sectors_api?: {
    key?: string;
    base_url?: string;
    cache_ttl_hours?: number;
  };
  features?: {
    auto_sync?: boolean;
    mock_mode?: boolean;
  };
}

/** Konfigurasi runtime hasil merge: env (paling tinggi) → config.json → default. */
export interface FinharnessConfig {
  homeDir: string;
  llm: { agent: LLMModelConfig; router: LLMModelConfig };
  sectors: {
    apiKey: string;
    baseUrl: string;
    cacheTtlHours: number;
    mock: boolean;
  };
  /** Mock LLM deterministik offline (development/E2E). */
  mockLlm: boolean;
  debug: boolean;
}

export interface ConfigOverrides {
  homeDir?: string;
  mockSectors?: boolean;
  mockLlm?: boolean;
}

function readConfigFile(homeDir: string): ConfigFile | null {
  const path = join(homeDir, 'config.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
  } catch {
    return null; // file korup → abaikan (pesan error muncul bila API key dibutuhkan)
  }
}

type Provider = LLMModelConfig['provider'];
function providerOr(value: string | undefined): Provider {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}

export function loadConfig(overrides: ConfigOverrides = {}): FinharnessConfig {
  const homeDir =
    overrides.homeDir ?? process.env[ENV.home] ?? join(homedir(), DATA_DIR_NAME);
  const file = readConfigFile(homeDir);

  const fileAgent = file?.llm?.agent;
  const fileRouter = file?.llm?.router;
  const envAgentProvider = process.env[ENV.llmProvider];
  const envAgentModel = process.env[ENV.llmModel];
  const envRouterProvider = process.env[ENV.llmRouterProvider];
  const envRouterModel = process.env[ENV.llmRouterModel];
  const envBaseUrl = process.env[ENV.llmBaseUrl];
  const envApiKey = process.env[ENV.llmApiKey];

  const agent: LLMModelConfig = {
    provider: envAgentProvider !== undefined ? providerOr(envAgentProvider) : (fileAgent?.provider ?? DEFAULT_AGENT_CONFIG.provider),
    model: envAgentModel ?? fileAgent?.model ?? DEFAULT_AGENT_CONFIG.model,
    temperature: fileAgent?.temperature ?? DEFAULT_AGENT_CONFIG.temperature,
    maxTokens: fileAgent?.maxTokens ?? DEFAULT_AGENT_CONFIG.maxTokens,
    baseURL: envBaseUrl ?? fileAgent?.base_url,
    apiKey: envApiKey ?? fileAgent?.api_key,
  };
  const router: LLMModelConfig = {
    provider:
      envRouterProvider !== undefined
        ? providerOr(envRouterProvider)
        : envAgentProvider !== undefined
          ? providerOr(envAgentProvider)
          : (fileRouter?.provider ?? fileAgent?.provider ?? DEFAULT_ROUTER_CONFIG.provider),
    model: envRouterModel ?? fileRouter?.model ?? DEFAULT_ROUTER_CONFIG.model,
    temperature: fileRouter?.temperature ?? DEFAULT_ROUTER_CONFIG.temperature,
    maxTokens: fileRouter?.maxTokens ?? DEFAULT_ROUTER_CONFIG.maxTokens,
    baseURL: envBaseUrl ?? fileRouter?.base_url,
    apiKey: envApiKey ?? fileRouter?.api_key,
  };

  const envMockSectors = process.env[ENV.mockSectors];
  const sectorsMock =
    overrides.mockSectors ??
    (envMockSectors !== undefined
      ? envMockSectors === 'true'
      : (file?.features?.mock_mode ?? false));

  const envMockLlm = process.env[ENV.mockLlm];
  const mockLlm = overrides.mockLlm ?? (envMockLlm === 'true');

  return {
    homeDir,
    llm: { agent, router },
    sectors: {
      apiKey: process.env.SECTORS_API_KEY ?? file?.sectors_api?.key ?? '',
      baseUrl: file?.sectors_api?.base_url ?? 'https://api.sectors.app/v1',
      cacheTtlHours: file?.sectors_api?.cache_ttl_hours ?? 24,
      mock: sectorsMock,
    },
    mockLlm,
    debug: process.env[ENV.debug] === 'true',
  };
}
