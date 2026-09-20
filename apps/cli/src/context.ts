import type { FinharnessDatabase } from '@harness/database';
import { fileURLToPath } from 'node:url';
import { ClaimValidator } from '@harness/execution';
import { createLLMClient, type ModelRuntimePlan } from '@harness/llm';
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
  runtimePlan?: ModelRuntimePlan;
}

export interface RuntimeBudget {
  readonly modelCapabilities: {
    readonly contextWindowTokens: number;
    readonly fallbackContextWindowTokens?: readonly number[];
  };
  readonly reservedOutputTokens: number;
}

/** Derives context policy from the immutable runtime plan, including every retry route. */
export function runtimeBudgetForPlan(plan: ModelRuntimePlan): RuntimeBudget {
  const routes = [plan.primary, ...plan.fallbacks];
  const outputLimits = routes.map(({ descriptor }) =>
    descriptor.capabilities.maxOutputTokens ?? descriptor.generationControls.maxOutputTokens,
  );
  return {
    modelCapabilities: {
      contextWindowTokens: plan.primary.descriptor.capabilities.contextWindowTokens,
      ...(plan.fallbacks.length
        ? { fallbackContextWindowTokens: plan.fallbacks.map(route => route.descriptor.capabilities.contextWindowTokens) }
        : {}),
    },
    reservedOutputTokens: Math.max(...outputLimits),
  };
}

export function buildContext(db: FinharnessDatabase, config: FinharnessConfig): HarnessContext {
  const agentLlm = createLLMClient(config.llm.agent, { mock: config.mockLlm });
  const routerLlm = createLLMClient(config.llm.router, { mock: config.mockLlm });
  const runtimePlan = agentLlm.describeRuntimePlan();
  const runtimeBudget = runtimeBudgetForPlan(runtimePlan);
  const modelCapabilities = runtimeBudget.modelCapabilities;
  const specialist = (directory: string) => new SubagentRuntime(
    agentLlm,
    new FilesystemSkillProvider(fileURLToPath(new URL(`../../../packages/subagent/${directory}/`, import.meta.url))),
    {
      contextSnapshotStore: db.contextSnapshots,
      budget: {
        modelCapabilities: {
          ...modelCapabilities,
        },
        reservedOutputTokens: runtimeBudget.reservedOutputTokens,
        safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
      },
    },
  );
  return {
    config,
    runtimePlan,
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
        ...modelCapabilities,
      },
      reservedOutputTokens: runtimeBudget.reservedOutputTokens,
      safetyMarginTokens: DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS,
    }),
    validator: new ClaimValidator(db.evidence),
    researchers: config.researchers,
    homeDir: config.homeDir,
  };
}
