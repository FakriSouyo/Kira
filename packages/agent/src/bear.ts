import { randomUUID } from 'node:crypto';
import type { EvidenceStore } from '@harness/evidence';
import type { LLMClientLike } from '@harness/llm';
import type { Claim } from '@harness/schemas';
import { BEAR_SYSTEM_PROMPT, buildBearPrompt } from './prompts/bear';
import { buildEvidenceZone } from './prompts/common';
import { BearLLMOutputSchema, type BearChallengeResponse } from './types';

/**
 * Bear Agent (addendum §15/Task 11 — Phase 1 "Debate ronde") — pure function:
 * membaca evidence (read-only) + klaim Bull, mengembalikan challenge
 * terstruktur. TIDAK menulis database (prinsip 6, §04).
 */
export class BearAgent {
  constructor(
    private readonly llm: LLMClientLike,
    private readonly evidenceStore: EvidenceStore,
  ) {}

  async challenge(params: {
    ticker: string;
    evidenceIds: string[];
    bullClaims: Claim[];
  }): Promise<BearChallengeResponse> {
    // 1. Ambil evidence (read-only)
    const evidence = await this.evidenceStore.getManyByIds(params.evidenceIds);

    // 2. Zona [1] = preamble + evidence block (byte-identical dengan agent lain, §17)
    const sharedZone = buildEvidenceZone(params.ticker, evidence);

    // 3. Generate structured output (Zod mendefinisikan struktur, LLM mengisi)
    const output = await this.llm.generateObject({
      schema: BearLLMOutputSchema,
      system: [sharedZone, BEAR_SYSTEM_PROMPT],
      prompt: buildBearPrompt(params.ticker, params.bullClaims),
    });

    // 4. Respons murni — tanpa efek samping
    return { ...output, messageId: `bear_${randomUUID()}` };
  }
}
