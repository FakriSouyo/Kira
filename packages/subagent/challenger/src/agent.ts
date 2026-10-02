import { ValidationError } from '@harness/shared';
import { type SubagentResult, SubagentRuntime } from '@harness/subagent-core';
import { CHALLENGER_MANIFEST } from './manifest.js';
import { ChallengeAnalystOutputSchema, type ChallengeAnalystOutput } from './schema.js';

export interface ChallengeRequest {
  ticker: string;
  thesis: string;
  evidenceZone: string;
}

/** Pure thesis challenger; execution scope and Evidence grounding stay in Engine. */
export class ChallengerAgent {
  constructor(private readonly runtime: SubagentRuntime) {}

  async challenge(request: ChallengeRequest): Promise<SubagentResult<ChallengeAnalystOutput>> {
    const ticker = request.ticker.trim().toUpperCase();
    const thesis = request.thesis.trim();
    if (!/^[A-Z]{2,6}$/.test(ticker)) throw new ValidationError('Challenge requires a valid ticker');
    if (!thesis) throw new ValidationError('Challenge requires an explicit thesis');
    if (!request.evidenceZone.trim()) throw new ValidationError('Challenge requires an Evidence zone');

    return await this.runtime.runObject({
      manifest: CHALLENGER_MANIFEST,
      evidenceZone: request.evidenceZone,
      prompt: [
        `Challenge target: ${ticker}`,
        `Explicit thesis: ${thesis}`,
        'Return the thesis, a balanced supporting and counter case, unsupported assumptions, failure conditions, evidence that would change the thesis, source assessments, gaps, and exact source coverage.',
        'Use only the supplied Evidence IDs and source strings. Do not make numeric assertions unless they have a cited Evidence path and exact value and period.',
      ].join('\n'),
      schema: ChallengeAnalystOutputSchema,
    });
  }
}
