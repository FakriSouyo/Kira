import type { ArtifactEnvelope, DurableArtifactRef } from '@harness/schemas';

export type { ArtifactEnvelope, ArtifactKind, DurableArtifactRef } from '@harness/schemas';

/** Durable artifact lookup boundary. Implementations live in persistence packages. */
export interface ArtifactStore {
  save(artifact: ArtifactEnvelope): Promise<ArtifactEnvelope>;
  saveMany(artifacts: readonly ArtifactEnvelope[]): Promise<ArtifactEnvelope[]>;
  getById(artifactId: string): Promise<ArtifactEnvelope | null>;
  getByExecution(executionId: string): Promise<ArtifactEnvelope[]>;
  resolve(ref: DurableArtifactRef): Promise<ArtifactEnvelope | null>;
}
