import { BullProposalOutputSchema, type BearCounterpoint, type BullProposalOutput } from '@harness/schemas';
import { type SubagentResult, SubagentRuntime } from '@harness/subagent-core';
import type { SpecialistContextPacket } from '@harness/context';
import { BULL_MANIFEST } from './manifest.js';

export interface BullAnalysisRequest {
  ticker?: string;
  evidenceZone?: string;
  context?: SpecialistContextPacket;
}

export interface BullRebuttalRequest extends BullAnalysisRequest {
  bearCounterpoints?: BearCounterpoint[];
}

export class BullAgent {
  constructor(private readonly runtime: SubagentRuntime) {}

  async analyze(request: BullAnalysisRequest): Promise<SubagentResult<BullProposalOutput>> {
    return await this.runtime.runObject({
      manifest: BULL_MANIFEST,
      ...(request.context ? { specialistContext: request.context } : { evidenceZone: request.evidenceZone }),
      prompt: `Analyze the evidence and produce the strongest evidence-backed bullish thesis for ${request.context?.specialist.subject.ticker ?? request.ticker}. Return reasoning and cited claims.`,
      schema: BullProposalOutputSchema,
    });
  }

  async rebuttal(request: BullRebuttalRequest): Promise<SubagentResult<BullProposalOutput>> {
    const bearCounterpoints = request.bearCounterpoints ?? request.context?.specialist.bearCounterpoints ?? [];
    const challenges = bearCounterpoints.map(
      (counterpoint, index) => `${index + 1}. Targets claim ${counterpoint.targetClaimId} (strength: ${counterpoint.strength}): ${counterpoint.argument}`,
    ).join('\n');
    return await this.runtime.runObject({
      manifest: BULL_MANIFEST,
      ...(request.context ? { specialistContext: request.context } : { evidenceZone: request.evidenceZone }),
      prompt: [
        `Defend the evidence-backed thesis for ${request.context?.specialist.subject.ticker ?? request.ticker}.`,
        'Bear Agent raised the following challenges:',
        challenges,
        'Address each challenge directly and return fresh rebuttal claim IDs with exact evidence citations.',
      ].join('\n'),
      schema: BullProposalOutputSchema,
    });
  }
}
