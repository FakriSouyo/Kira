import { BearLLMOutputSchema, type BearLLMOutput, type Claim } from '@harness/schemas';
import { type SubagentResult, SubagentRuntime } from '@harness/subagent-core';
import { BEAR_MANIFEST } from './manifest.js';

export interface BearChallengeRequest {
  ticker: string;
  evidenceZone: string;
  bullClaims: Claim[];
}

export class UnknownTargetClaimError extends Error {
  readonly code = 'UNKNOWN_TARGET_CLAIM';

  constructor(readonly claimId: string) {
    super(`Bear counterpoint targets unknown Bull claim: ${claimId}`);
    this.name = 'UnknownTargetClaimError';
  }
}

export class BearAgent {
  constructor(private readonly runtime: SubagentRuntime) {}

  async challenge(request: BearChallengeRequest): Promise<SubagentResult<BearLLMOutput>> {
    const claims = request.bullClaims.map((claim, index) => [
      `${index + 1}. ${claim.statement} (claim: ${claim.claimId}, Confidence: ${claim.confidence})`,
      `   Evidence: ${claim.evidenceIds.join(', ')}`,
      `   Reasoning: ${claim.reasoning}`,
    ].join('\n')).join('\n');
    const result = await this.runtime.runObject({
      manifest: BEAR_MANIFEST,
      evidenceZone: request.evidenceZone,
      prompt: [
        `Evaluate the bullish thesis for ${request.ticker}.`,
        'Bull Agent made the following claims:',
        claims,
        'Challenge the claims critically but fairly. Each counterpoint must target an existing claim ID.',
      ].join('\n'),
      schema: BearLLMOutputSchema,
    });

    const knownClaims = new Set(request.bullClaims.map((claim) => claim.claimId));
    for (const counterpoint of result.value.counterpoints) {
      if (!knownClaims.has(counterpoint.targetClaimId)) {
        throw new UnknownTargetClaimError(counterpoint.targetClaimId);
      }
    }
    return result;
  }
}
