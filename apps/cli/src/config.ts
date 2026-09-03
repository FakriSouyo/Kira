import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    /**
     * Legacy — preferensi dipindah ke `.credentials.json` (§12). Dipertahankan
     * sebagai fallback backward-compat, prioritas di bawah env & credentials.
     */
    key?: string;
    base_url?: string;
    cache_ttl_hours?: number;
    /** TTL khusus News (jam); default 1 (addendum §24-A.6). */
    news_cache_ttl_hours?: number;
  };
  features?: {
    auto_sync?: boolean;
    mock_mode?: boolean;
    /** Market & News Researcher aktif per `/judge`; default true (addendum §24-A.6). */
    market_researcher?: boolean;
    news_researcher?: boolean;
  };
}

/**
 * Bentuk file kredensial terpisah (addendum §12 · .credentials.json) — hanya
 * menyimpan nilai key mentah, bukan pengaturan. Dipisah dari `config.json`
 * agar isi config selalu bersih (aman di-screenshot/di-share). Prioritas key:
 * env → .credentials.json → config.json (legacy) → empty.
 */
interface CredentialsFile {
  llm?: {
    agent?: { api_key?: string };
    router?: { api_key?: string };
  };
  sectors_api?: { key?: string };
}

/** Konfigurasi runtime hasil merge: env (tertinggi) → .credentials.json → config.json → default. */
export interface FinharnessConfig {
  homeDir: string;
  llm: { agent: LLMModelConfig; router: LLMModelConfig };
  sectors: {
    apiKey: string;
    baseUrl: string;
    cacheTtlHours: number;
    newsCacheTtlHours: number;
    mock: boolean;
  };
  /** Sub-researcher Market/News untuk flow /judge (addendum §24-A.6). */
  researchers: { market: boolean; news: boolean };
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

/** Baca `.credentials.json` (opsional). Kalau absen/korup → diabaikan (fallback ke env/config). */
function readCredentialsFile(homeDir: string): CredentialsFile | null {
  const path = join(homeDir, '.credentials.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CredentialsFile;
  } catch {
    return null;
  }
}

/** Gabungkan kredensial existing dengan partial baru; field yang diset `b` menang. */
function mergeCredentials(a: CredentialsFile, b: CredentialsFile): CredentialsFile {
  return {
    sectors_api: { key: b?.sectors_api?.key ?? a?.sectors_api?.key },
    llm: {
      agent: { api_key: b?.llm?.agent?.api_key ?? a?.llm?.agent?.api_key },
      router: { api_key: b?.llm?.router?.api_key ?? a?.llm?.router?.api_key },
    },
  };
}

/**
 * Tulis `~/.finharness/.credentials.json` dengan mode `0600` (Unix) — key mentah
 * hanya bisa dibaca pemilik file. Merge dengan file existing (overwrite per field),
 * membuat homeDir bila belum ada. Mengembalikan path file yang ditulis.
 */
export function writeCredentialsFile(homeDir: string, credentials: CredentialsFile): string {
  const path = join(homeDir, '.credentials.json');
  const merged = mergeCredentials(readCredentialsFile(homeDir) ?? {}, credentials);
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600); // berlaku utk file yang sudah ada (pesan macOS + *nix)
  } catch {
    // chmod adalah no-op di Windows; abaikan.
  }
  return path;
}

type Provider = LLMModelConfig['provider'];
function providerOr(value: string | undefined): Provider {
  return value === 'anthropic' ? 'anthropic' : 'openai';
}

export function loadConfig(overrides: ConfigOverrides = {}): FinharnessConfig {
  const homeDir =
    overrides.homeDir ?? process.env[ENV.home] ?? join(homedir(), DATA_DIR_NAME);
  const file = readConfigFile(homeDir);
  const cred = readCredentialsFile(homeDir);

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
    apiKey: envApiKey ?? cred?.llm?.agent?.api_key ?? fileAgent?.api_key,
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
    apiKey: envApiKey ?? cred?.llm?.router?.api_key ?? fileRouter?.api_key,
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
      apiKey: process.env.SECTORS_API_KEY ?? cred?.sectors_api?.key ?? file?.sectors_api?.key ?? '',
      baseUrl: file?.sectors_api?.base_url ?? 'https://api.sectors.app/v1',
      cacheTtlHours: file?.sectors_api?.cache_ttl_hours ?? 24,
      newsCacheTtlHours: file?.sectors_api?.news_cache_ttl_hours ?? 1,
      mock: sectorsMock,
    },
    researchers: {
      market: file?.features?.market_researcher ?? true,
      news: file?.features?.news_researcher ?? true,
    },
    mockLlm,
    debug: process.env[ENV.debug] === 'true',
  };
}
