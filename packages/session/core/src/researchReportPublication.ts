import type { ResearchReportPayload } from '@harness/schemas';
import type { ResearchExecution } from './index.js';
import type { ArtifactEnvelope } from './artifact.js';

export type ResearchReportArtifact = Extract<ArtifactEnvelope, { kind: 'RESEARCH_REPORT' }>;

export interface ResearchReportPublication {
  execution: ResearchExecution;
  artifact: ResearchReportArtifact;
}

/** Atomically completes one Research Execution and publishes its durable report. */
export interface ResearchReportPublicationStore {
  completeAndPublish(params: {
    executionId: string;
    payload: ResearchReportPayload;
    executionTimeSeconds: number;
  }): Promise<ResearchReportPublication>;
}
