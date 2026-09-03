import type { FinharnessDatabase } from '@harness/database';
import { BearAgent, BullAgent, IntentRouter, JudgeAgent } from '@harness/agent';
import { ClaimValidator } from '@harness/execution';
import { createLLMClient } from '@harness/llm';
import { createSectorsApi, type SectorsApi } from '@harness/sectors-api';
import type { FinharnessConfig } from './config';

/**
 * Konteks harness — seluruh dependensi yang dibutuhkan command/workflow.
 * Dibangun sekali saat startup, dipakai REPL (addendum §23 apps/cli).
 */
export interface HarnessContext {
  db: FinharnessDatabase;
  sectors: SectorsApi;
  bull: BullAgent;
  bear: BearAgent;
  judge: JudgeAgent;
  router: IntentRouter;
  validator: ClaimValidator;
  /** Aktif/tidaknya sub-researcher Market & News untuk /judge (addendum §24-A.6). */
  researchers: { market: boolean; news: boolean };
}

export function buildContext(db: FinharnessDatabase, config: FinharnessConfig): HarnessContext {
  // Dua-tier LLM (addendum §17): tier 1 untuk agent, tier 2 untuk router.
  const agentLlm = createLLMClient(config.llm.agent, { mock: config.mockLlm });
  const routerLlm = createLLMClient(config.llm.router, { mock: config.mockLlm });

  return {
    db,
    sectors: createSectorsApi({
      mock: config.sectors.mock,
      apiKey: config.sectors.apiKey || undefined,
      baseUrl: config.sectors.baseUrl,
      cacheTtlHours: config.sectors.cacheTtlHours,
      newsCacheTtlHours: config.sectors.newsCacheTtlHours,
      homeDir: config.homeDir,
    }),
    bull: new BullAgent(agentLlm, db.evidence),
    bear: new BearAgent(agentLlm, db.evidence),
    judge: new JudgeAgent(agentLlm),
    router: new IntentRouter(routerLlm),
    validator: new ClaimValidator(db.evidence),
    researchers: config.researchers,
  };
}
