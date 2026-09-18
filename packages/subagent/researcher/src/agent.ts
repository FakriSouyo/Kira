import { type SubagentResult, SubagentRuntime } from '@harness/subagent-core';
import { RESEARCHER_MANIFEST } from './manifest.js';
import { ResearcherOutputSchema, type ResearcherOutput } from './schema.js';

export interface ResearchRequest {
  ticker: string;
  question: string;
  evidenceZone: string;
}

/** Source specialist used explicitly by command workflow definitions. */
export class ResearcherAgent {
  constructor(private readonly runtime: SubagentRuntime) {}

  async research(request: ResearchRequest): Promise<SubagentResult<ResearcherOutput>> {
    return await this.runtime.runObject({
      manifest: RESEARCHER_MANIFEST,
      evidenceZone: request.evidenceZone,
      prompt: [
        `Research target: ${request.ticker}`,
        `Question: ${request.question}`,
        'Return a concise synthesis, cited findings, an assessment for each cited source, and material evidence gaps.',
      ].join('\n'),
      schema: ResearcherOutputSchema,
    });
  }
}
