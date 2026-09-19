import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_NAME, ENV } from '@harness/shared';
import type { LLMModelConfig } from '@harness/llm';
import { DEFAULT_AGENT_CONFIG, DEFAULT_ROUTER_CONFIG } from '@harness/llm';

/** Bentuk model LLM di file konfigurasi (snake_case, konsisten dengan sectors_api). */
interface LLMModelFile {
  api?: LLMModelConfig['api'];
  provider_id?: string;
  provider?: LLMModelConfig['provider'];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  context_window_tokens?: number;
  /** Endpoint kustom (DeepSeek/OpenRouter/Ollama...); kosong = default provider. */
  base_url?: string;
  api_key?: string;
}

/** Bentuk file konfigurasi user (addendum §12 · config.json). */
interface ConfigFile {
  providers?: Record<string, SavedProvider>;
  provider_setup?: ProviderSetup;
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
  providers?: Record<string, { agent?: { api_key?: string }; router?: { api_key?: string } }>;
  llm?: {
    agent?: { api_key?: string };
    router?: { api_key?: string };
  };
  sectors_api?: { key?: string };
}

/** Konfigurasi runtime hasil merge: env (tertinggi) → .credentials.json → config.json → default. */
export interface FinharnessConfig {
  providers?: Record<string, SavedProvider>;
  providerSetup?: ProviderSetup;
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

/** User-facing provider identity and model choices; credentials live separately. */
export interface ProviderSetup {
  kind: 'official' | 'custom';
  id: string;
  name: string;
  models: Array<{ id: string; name: string }>;
}

export interface SavedProvider {
  setup: ProviderSetup;
  agent: LLMModelFile;
  router: LLMModelFile;
}

export interface ConfigOverrides {
  providerId?: string;
  /** Internal read-only composition path; never repairs or writes config.json. */
  skipRepair?: boolean;
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

function writeConfigFileAtomic(homeDir: string, file: ConfigFile): void {
  mkdirSync(homeDir, { recursive: true });
  const path = join(homeDir, 'config.json');
  const temporary = join(homeDir, `.config-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Keep each saved provider self-contained: assigned models must exist in its own catalog. */
function repairActiveProviderModels(homeDir: string, file: ConfigFile | null): ConfigFile | null {
  const id = file?.provider_setup?.id;
  const selected = id ? file?.providers?.[id] : undefined;
  const firstModel = selected?.setup.models[0]?.id;
  if (!file || !selected || !firstModel) return file;
  const ids = new Set(selected.setup.models.map(model => model.id));
  let changed = false;
  for (const tier of ['agent', 'router'] as const) {
    if (!selected[tier].model || !ids.has(selected[tier].model)) {
      selected[tier] = { ...selected[tier], model: firstModel };
      changed = true;
    }
  }
  if (changed) {
    file.llm = { ...file.llm, agent: selected.agent, router: selected.router };
    writeConfigFileAtomic(homeDir, file);
  }
  return file;
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
    providers: { ...a.providers, ...b.providers },
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
  const file = readConfigFile(homeDir);
  const id = file?.provider_setup?.id;
  if (credentials.llm && id && file?.providers?.[id]) {
    const old = readCredentialsFile(homeDir)?.providers?.[id];
    credentials = { ...credentials, providers: { ...credentials.providers, [id]: {
      agent: credentials.llm.agent ?? old?.agent, router: credentials.llm.router ?? old?.router,
    } } };
  }
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
  const file = overrides.skipRepair ? readConfigFile(homeDir) : repairActiveProviderModels(homeDir, readConfigFile(homeDir));
  const cred = readCredentialsFile(homeDir);

  const activeId = overrides.providerId ?? file?.provider_setup?.id;
  const selected = activeId ? file?.providers?.[activeId] : undefined;
  const scopedCredentials = selected && activeId ? cred?.providers?.[activeId] : undefined;
  const fileAgent = selected?.agent ?? file?.llm?.agent;
  const fileRouter = selected?.router ?? file?.llm?.router;
  const envAgentProvider = process.env[ENV.llmProvider];
  const envAgentModel = process.env[ENV.llmModel];
  const envRouterProvider = process.env[ENV.llmRouterProvider];
  const envRouterModel = process.env[ENV.llmRouterModel];
  const envBaseUrl = process.env[ENV.llmBaseUrl];
  const envApiKey = process.env[ENV.llmApiKey];

  const agent: LLMModelConfig = {
    providerId: envAgentProvider !== undefined ? envAgentProvider : (fileAgent?.provider_id ?? selected?.setup.id),
    provider: envAgentProvider !== undefined ? providerOr(envAgentProvider) : (fileAgent?.provider ?? DEFAULT_AGENT_CONFIG.provider),
    model: envAgentModel ?? fileAgent?.model ?? DEFAULT_AGENT_CONFIG.model,
    temperature: fileAgent?.temperature ?? DEFAULT_AGENT_CONFIG.temperature,
    maxTokens: fileAgent?.maxTokens ?? DEFAULT_AGENT_CONFIG.maxTokens,
    contextWindowTokens: fileAgent?.context_window_tokens ?? DEFAULT_AGENT_CONFIG.contextWindowTokens,
    baseURL: envBaseUrl ?? fileAgent?.base_url,
    apiKey: envApiKey ?? (selected ? scopedCredentials?.agent?.api_key : cred?.llm?.agent?.api_key ?? fileAgent?.api_key),
    api: fileAgent?.api,
  };
  const router: LLMModelConfig = {
    providerId: envRouterProvider ?? envAgentProvider ?? fileRouter?.provider_id ?? fileAgent?.provider_id ?? selected?.setup.id,
    provider:
      envRouterProvider !== undefined
        ? providerOr(envRouterProvider)
        : envAgentProvider !== undefined
          ? providerOr(envAgentProvider)
          : (fileRouter?.provider ?? fileAgent?.provider ?? DEFAULT_ROUTER_CONFIG.provider),
    model: envRouterModel ?? fileRouter?.model ?? DEFAULT_ROUTER_CONFIG.model,
    temperature: fileRouter?.temperature ?? DEFAULT_ROUTER_CONFIG.temperature,
    maxTokens: fileRouter?.maxTokens ?? DEFAULT_ROUTER_CONFIG.maxTokens,
    contextWindowTokens: fileRouter?.context_window_tokens ?? DEFAULT_ROUTER_CONFIG.contextWindowTokens,
    baseURL: envBaseUrl ?? fileRouter?.base_url,
    apiKey: envApiKey ?? (selected ? scopedCredentials?.router?.api_key : cred?.llm?.router?.api_key ?? fileRouter?.api_key),
    api: fileRouter?.api,
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
    providerSetup: selected?.setup ?? file?.provider_setup,
    providers: file?.providers,
    llm: { agent, router },
    sectors: {
      apiKey: process.env.SECTORS_API_KEY ?? cred?.sectors_api?.key ?? file?.sectors_api?.key ?? '',
      baseUrl: file?.sectors_api?.base_url ?? 'https://api.sectors.app/v2',
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

/** Persist the model selected in the workspace for the active provider. */
export function writeActiveModel(homeDir: string, model: string): void {
  const current = readConfigFile(homeDir);
  if (!current) return;
  const id = current.provider_setup?.id;
  current.llm ??= {};
  current.llm.agent = { ...current.llm.agent, model };
  if (id && current.providers?.[id]) {
    current.providers[id] = {
      ...current.providers[id],
      agent: { ...current.providers[id].agent, model },
    };
  }
  const path = join(homeDir, 'config.json');
  const temporary = join(homeDir, `.model-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

/** Activate one saved provider/model as a single persisted operation. */
export function writeActiveProviderModel(homeDir: string, providerId: string, model: string): void {
  const current = readConfigFile(homeDir);
  const saved = current?.providers?.[providerId];
  if (!current || !saved) throw new Error(`Unknown saved provider: ${providerId}`);
  if (!saved.setup.models.some(candidate => candidate.id === model)) {
    throw new Error(`Model ${model} does not belong to provider ${providerId}`);
  }
  saved.agent = { ...saved.agent, model };
  current.provider_setup = saved.setup;
  current.llm = { agent: saved.agent, router: saved.router };
  writeConfigFileAtomic(homeDir, current);
}
