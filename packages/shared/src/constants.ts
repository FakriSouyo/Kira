export const DATA_DIR_NAME = '.finharness';
export const DB_FILE_NAME = 'finharness.db';

export const ENV = {
  home: 'FINHARNESS_HOME',
  mockSectors: 'FINHARNESS_MOCK_SECTORS',
  mockLlm: 'FINHARNESS_MOCK_LLM',
  debug: 'FINHARNESS_DEBUG',
  llmProvider: 'LLM_PROVIDER',
  llmModel: 'LLM_MODEL',
  llmRouterProvider: 'LLM_ROUTER_PROVIDER',
  llmRouterModel: 'LLM_ROUTER_MODEL',
  llmBaseUrl: 'LLM_BASE_URL',
  llmApiKey: 'LLM_API_KEY',
} as const;

export const AGENTS = ['researcher', 'bull', 'bear', 'judge'] as const;
export type AgentName = (typeof AGENTS)[number];

export const MESSAGE_TYPES = [
  'observation',
  'claim',
  'challenge',
  'response',
  'decision',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
