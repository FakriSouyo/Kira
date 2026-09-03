import { randomUUID } from 'node:crypto';
import type { EvidenceStore } from '@harness/evidence';
import type { LLMClientLike } from '@harness/llm';
import { BULL_SYSTEM_PROMPT, buildBullPrompt, buildBullRebuttalPrompt } from './prompts/bull';
import { buildEvidenceZone } from './prompts/common';
import {
  BullLLMOutputSchema,
  type BearCounterpoint,
  type BullAnalysisResponse,
} from './types';

/**
 * Bull Agent (addendum §15/Task 10) — pure function:
 * membaca evidence (read-only) dan mengembalikan hasil terstruktur.
 * TIDAK menulis database — workflow menangani persistence (prinsip 6, §04).
 */
export class BullAgent {
  constructor(
    private readonly llm: LLMClientLike,
    private readonly evidenceStore: EvidenceStore,
  ) {}

  async analyze(params: { ticker: string; evidenceIds: string[] }): Promise<BullAnalysisResponse> {
    // 1. Ambil evidence (read-only)
    const evidence = await this.evidenceStore.getManyByIds(params.evidenceIds);

    // 2. Zona [1] = preamble + evidence block (byte-identical untuk cache, §17)
    const sharedZone = buildEvidenceZone(params.ticker, evidence);

    // 3. Generate structured output (Zod mendefinisikan struktur, LLM mengisi)
    const output = await this.llm.generateObject({
      schema: BullLLMOutputSchema,
      system: [sharedZone, BULL_SYSTEM_PROMPT],
      prompt: buildBullPrompt(params.ticker),
    });

    // 4. Respons murni — tanpa efek samping
    return { ...output, messageId: `bull_${randomUUID()}` };
  }

  /**
   * Rebuttal terhadap challenge Bear (Phase 1, "Debate ronde" — addendum §15):
   * pola identik dengan analyze — fetch evidence → build prompt → generate →
   * return pure response.
   */
  async rebuttal(params: {
    ticker: string;
    evidenceIds: string[];
    bearCounterpoints: BearCounterpoint[];
  }): Promise<BullAnalysisResponse> {
    const evidence = await this.evidenceStore.getManyByIds(params.evidenceIds);
    const sharedZone = buildEvidenceZone(params.ticker, evidence);

    const output = await this.llm.generateObject({
      schema: BullLLMOutputSchema,
      system: [sharedZone, BULL_SYSTEM_PROMPT],
      prompt: buildBullRebuttalPrompt(params.ticker, params.bearCounterpoints),
    });

    return { ...output, messageId: `bull_rebuttal_${randomUUID()}` };
  }
}
