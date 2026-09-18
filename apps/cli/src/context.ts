import type { FinharnessDatabase } from '@harness/database';
import { fileURLToPath } from 'node:url';
import { ClaimValidator } from '@harness/execution';
import { createLLMClient, DEFAULT_CONTEXT_WINDOW_TOKENS } from '@harness/llm';
import { DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS } from '@harness/context';
import { IntentRouter } from '@harness/routing';
import { MainFinHarnessAgent } from '@harness/orchestrator';
import { createSectorsFinancialDataProvider } from '@harness/sectors-api';
import type { FinancialDataProvider } from '@harness/financial-data';
import { FilesystemSkillProvider } from '@harness/skill-filesystem';
import { BearAgent } from '@harness/subagent-bear';
import { BullAgent } from '@harness/subagent-bull';
import { SubagentRuntime } from '@harness/subagent-core';
import { JudgeAgent } from '@harness/subagent-judge';
import { ResearcherAgent } from '@harness/subagent-researcher';
import type { FinharnessConfig } from './config';
import { createConversationContextCoordinator, type ConversationContextCoordinator } from './runtime/conversationContextCoordinator';

export interface HarnessContext {
  db: FinharnessDatabase;
  financialData: FinancialDataProvider;
  researcher: ResearcherAgent;
  bull: BullAgent;
  bear: BearAgent;
  judge: JudgeAgent;
  router: IntentRouter;
  mainAgent: MainFinHarnessAgent;
  conversationContext: ConversationContextCoordinator;
  validator: ClaimValidator;
  researchers: { market: boolean; news: boolean };
  homeDir: string;
  config?: FinharnessConfig;
}

export function buildContext(db: FinharnessDatabase, config: FinharnessConfig): HarnessContext {
  const agentLlm = createLLMClient(config.llm.agent, { mock: config.mockLlm });
  const routerLlm = createLLMClient(config.llm.router, { mock: config.mockLlm });
  const specialist = (directory: string) => new SubagentRuntime(
    agentLlm,
    new FilesystemSkillProvider(fileURLToPath(new URL(`../../../packages/subagent/${directory}/`, import.meta.url))),
    {
      contextSnapshotStore: db.contextSnapshots,
      budget: {
        modelCapabilities: {
          // The deterministic mock has no provider-side context limit. Keep
          // PR J's deliberately small window available to conversation tests;
          // real lifecycle calls use the configured agent capability exactly.
          contextWindowTokens: config.mockLlm
            ? DEFAULT_CONTEXT_WINDOW_TOKENS
            : config.llm.agent.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
        },
        reservedOutputTokens: config.llm.agent.maxTokens,
        safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
      },
      modelIdentity: { provider: config.llm.agent.provider, model: config.llm.agent.model },
    },
  );
  return {
    config,
    db,
    financialData: createSectorsFinancialDataProvider({
      mock: config.sectors.mock,
      apiKey: config.sectors.apiKey || undefined,
      baseUrl: config.sectors.baseUrl,
      cacheTtlHours: config.sectors.cacheTtlHours,
      newsCacheTtlHours: config.sectors.newsCacheTtlHours,
      homeDir: config.homeDir,
    }),
    researcher: new ResearcherAgent(specialist('researcher')),
    bull: new BullAgent(specialist('bull')),
    bear: new BearAgent(specialist('bear')),
    judge: new JudgeAgent(specialist('judge')),
    router: new IntentRouter(routerLlm),
    mainAgent: new MainFinHarnessAgent(agentLlm),
    conversationContext: createConversationContextCoordinator(db, {
      modelCapabilities: {
        contextWindowTokens: config.llm.agent.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      },
      reservedOutputTokens: config.llm.agent.maxTokens,
      safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
    }),
    validator: new ClaimValidator(db.evidence),
    researchers: config.researchers,
    homeDir: config.homeDir,
  };
}
