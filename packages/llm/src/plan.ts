import { createHash } from 'node:crypto';
import { canonicalJson } from '@harness/shared';
import type { ModelRuntimeDescriptor, ModelGenerationControls } from './descriptor';
import type { ModelRoute } from './provider-directory';

export const MODEL_RUNTIME_PLAN_VERSION = 1 as const;

export interface ModelRuntimePlanRoute {
  readonly route: ModelRoute;
  readonly descriptor: ModelRuntimeDescriptor;
}

export interface ModelRuntimePlan {
  readonly schemaVersion: typeof MODEL_RUNTIME_PLAN_VERSION;
  readonly primary: ModelRuntimePlanRoute;
  readonly fallbacks: readonly ModelRuntimePlanRoute[];
  readonly runtimeFingerprint: string;
}

export interface ModelRuntimePlanRequest {
  readonly route: ModelRoute;
  readonly generationControls: ModelGenerationControls;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

export function createModelRuntimePlan(routes: readonly ModelRuntimePlanRoute[]): ModelRuntimePlan {
  const [primary, ...fallbacks] = routes;
  if (!primary) throw new Error('Model runtime plan requires a primary route');
  const semantic = {
    schemaVersion: MODEL_RUNTIME_PLAN_VERSION,
    primary: { route: primary.route, descriptor: primary.descriptor },
    fallbacks: fallbacks.map(route => ({ route: route.route, descriptor: route.descriptor })),
  };
  const runtimeFingerprint = createHash('sha256').update(canonicalJson(semantic), 'utf8').digest('hex');
  return freezeDeep({ ...semantic, runtimeFingerprint });
}
