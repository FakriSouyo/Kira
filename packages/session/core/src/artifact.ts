import type { ArtifactEnvelope, ArtifactRetrievalQuery, DurableArtifactRef } from '@harness/schemas';

export type { ArtifactEnvelope, ArtifactKind, ArtifactRetrievalQuery, DurableArtifactRef } from '@harness/schemas';

export type ArtifactSourceExecution = {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly attempt: number;
  readonly ticker: string;
  readonly command: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly completedAt: string | null;
};

/** Durable artifact lookup boundary. Implementations live in persistence packages. */
export interface ArtifactStore {
  save(artifact: ArtifactEnvelope): Promise<ArtifactEnvelope>;
  saveMany(artifacts: readonly ArtifactEnvelope[]): Promise<ArtifactEnvelope[]>;
  getById(artifactId: string): Promise<ArtifactEnvelope | null>;
  getByExecution(executionId: string): Promise<ArtifactEnvelope[]>;
  listByQuery(query: ArtifactRetrievalQuery): Promise<ArtifactEnvelope[]>;
  getSourceExecution(executionId: string): Promise<ArtifactSourceExecution | null>;
  resolve(ref: DurableArtifactRef): Promise<ArtifactEnvelope | null>;
}
