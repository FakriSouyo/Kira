import type { ComparisonReportPayload } from '@harness/schemas';
import type { ResearchExecution } from './index.js';
import type { ArtifactEnvelope } from './artifact.js';

export type ComparisonReportArtifact = Extract<ArtifactEnvelope, { kind: 'COMPARISON_REPORT' }>;

export interface ComparisonReportPublication {
  execution: ResearchExecution;
  artifact: ComparisonReportArtifact;
}

/** Atomically completes one Compare Execution and publishes its durable matrix. */
export interface ComparisonReportPublicationStore {
  completeAndPublish(params: {
    executionId: string;
    payload: ComparisonReportPayload;
    executionTimeSeconds: number;
  }): Promise<ComparisonReportPublication>;
}
