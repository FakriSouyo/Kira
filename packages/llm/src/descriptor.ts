import { createHash } from 'node:crypto';
import { canonicalJson } from '@harness/shared';
import type { ModelDescriptor } from './provider-directory';

export const MODEL_RUNTIME_DESCRIPTOR_VERSION = 1 as const;

export interface ModelGenerationControls {
  readonly temperature: number;
  readonly maxOutputTokens: number;
}

export interface ModelRuntimeDescriptor {
  readonly schemaVersion: typeof MODEL_RUNTIME_DESCRIPTOR_VERSION;
  readonly providerId: string;
  readonly modelId: string;
  readonly adapterId: string;
  readonly protocol: string;
  readonly endpointFingerprint?: string;
  readonly capabilities: ModelDescriptor['capabilities'];
  readonly generationControls: ModelGenerationControls;
  readonly runtimeFingerprint: string;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function fingerprintInput(descriptor: Omit<ModelRuntimeDescriptor, 'runtimeFingerprint'>): Omit<ModelRuntimeDescriptor, 'runtimeFingerprint'> {
  return descriptor;
}

export function createModelRuntimeDescriptor(params: {
  readonly model: ModelDescriptor;
  readonly generationControls: ModelGenerationControls;
}): ModelRuntimeDescriptor {
  const semantic = {
    schemaVersion: MODEL_RUNTIME_DESCRIPTOR_VERSION,
    providerId: params.model.route.providerId,
    modelId: params.model.route.modelId,
    adapterId: params.model.provider.adapterId,
    protocol: params.model.provider.protocol,
    ...(params.model.provider.endpointFingerprint ? { endpointFingerprint: params.model.provider.endpointFingerprint } : {}),
    capabilities: params.model.capabilities,
    generationControls: { ...params.generationControls },
  } satisfies Omit<ModelRuntimeDescriptor, 'runtimeFingerprint'>;
  const runtimeFingerprint = createHash('sha256').update(canonicalJson(fingerprintInput(semantic)), 'utf8').digest('hex');
  return freezeDeep({ ...semantic, runtimeFingerprint });
}
