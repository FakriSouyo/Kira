import { BullLLMOutputSchema, type BearCounterpoint, type BullLLMOutput } from '@harness/schemas';
import { type SubagentResult, SubagentRuntime } from '@harness/subagent-core';
import { BULL_MANIFEST } from './manifest.js';

export interface BullAnalysisRequest {
  ticker: string;
  evidenceZone: string;
}

export interface BullRebuttalRequest extends BullAnalysisRequest {
  bearCounterpoints: BearCounterpoint[];
}

export class BullAgent {
  constructor(private readonly runtime: SubagentRuntime) {}

  async analyze(request: BullAnalysisRequest): Promise<SubagentResult<BullLLMOutput>> {
    return await this.runtime.runObject({
      manifest: BULL_MANIFEST,
      evidenceZone: request.evidenceZone,
      prompt: `Analyze the evidence and produce the strongest evidence-backed bullish thesis for ${request.ticker}. Return reasoning and cited claims.`,
      schema: BullLLMOutputSchema,
    });
  }

  async rebuttal(request: BullRebuttalRequest): Promise<SubagentResult<BullLLMOutput>> {
    const challenges = request.bearCounterpoints.map(
      (counterpoint, index) => `${index + 1}. Targets claim ${counterpoint.targetClaimId} (strength: ${counterpoint.strength}): ${counterpoint.argument}`,
    ).join('\n');
    return await this.runtime.runObject({
      manifest: BULL_MANIFEST,
      evidenceZone: request.evidenceZone,
      prompt: [
        `Defend the evidence-backed thesis for ${request.ticker}.`,
        'Bear Agent raised the following challenges:',
        challenges,
        'Address each challenge directly and return fresh rebuttal claim IDs with exact evidence citations.',
      ].join('\n'),
      schema: BullLLMOutputSchema,
    });
  }
}
