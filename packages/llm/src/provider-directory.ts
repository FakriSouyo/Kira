import { RuntimeError } from './errors';

export interface ModelRoute {
  readonly providerId: string;
  readonly modelId: string;
}

export function sameModelRoute(left: ModelRoute, right: ModelRoute): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}

export function modelRouteKey(route: ModelRoute): string {
  return `${route.providerId}\u0000${route.modelId}`;
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly adapterId: string;
  readonly protocol: string;
  readonly endpointFingerprint?: string;
}

export interface ModelCapabilities {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens?: number;
  readonly supportsTextInput: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly supportsTextStreaming: boolean;
  readonly supportsStructuredStreaming: boolean;
  readonly nativeStructuredOutput?: boolean;
  readonly reasoningEfforts?: readonly string[];
  readonly inputModalities?: readonly string[];
}

export interface ModelDescriptor {
  readonly route: ModelRoute;
  readonly provider: ProviderDescriptor;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
}

export interface ModelRegistration {
  readonly id: string;
  readonly displayName?: string;
  readonly capabilities: ModelCapabilities;
  /** Private adapter connection data; never part of a resolved safe descriptor. */
  readonly connection?: unknown;
}

export interface ProviderRegistration {
  readonly descriptor: ProviderDescriptor;
  readonly models: readonly ModelRegistration[];
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new RuntimeError('INVALID_RUNTIME_CONFIG', `${label} must be non-empty`);
  return value;
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  }
  return value;
}

function cloneSafe<T>(value: T): T {
  return freezeDeep(structuredClone(value));
}

export class ProviderDirectory {
  private readonly providers: ReadonlyMap<string, ProviderDescriptor>;
  private readonly models: ReadonlyMap<string, ReadonlyMap<string, ModelDescriptor>>;
  private readonly connections: ReadonlyMap<string, unknown>;

  constructor(registrations: readonly ProviderRegistration[]) {
    const providers = new Map<string, ProviderDescriptor>();
    const models = new Map<string, ReadonlyMap<string, ModelDescriptor>>();
    const connections = new Map<string, unknown>();

    for (const registration of registrations) {
      const descriptor = registration.descriptor;
      required(descriptor.id, 'provider id');
      required(descriptor.adapterId, `adapter for provider ${descriptor.id}`);
      required(descriptor.protocol, `protocol for provider ${descriptor.id}`);
      if (providers.has(descriptor.id)) throw new RuntimeError('DUPLICATE_PROVIDER', `Provider ${descriptor.id} is registered more than once`);

      const safeProvider = freezeDeep(cloneSafe({ ...descriptor }));
      const providerModels = new Map<string, ModelDescriptor>();
      for (const registrationModel of registration.models) {
        required(registrationModel.id, `model for provider ${descriptor.id}`);
        if (providerModels.has(registrationModel.id)) {
          throw new RuntimeError('DUPLICATE_MODEL', `Model ${descriptor.id}/${registrationModel.id} is registered more than once`);
        }
        const route = freezeDeep({ providerId: descriptor.id, modelId: registrationModel.id });
        const model = freezeDeep(cloneSafe({
          route,
          provider: safeProvider,
          displayName: registrationModel.displayName ?? registrationModel.id,
          capabilities: registrationModel.capabilities,
        } satisfies ModelDescriptor));
        providerModels.set(registrationModel.id, model);
        if (registrationModel.connection !== undefined) connections.set(modelRouteKey(route), registrationModel.connection);
      }
      providers.set(descriptor.id, safeProvider);
      models.set(descriptor.id, providerModels);
    }
    this.providers = providers;
    this.models = models;
    this.connections = connections;
  }

  listProviders(): readonly ProviderDescriptor[] {
    return [...this.providers.values()].sort((left, right) => left.id.localeCompare(right.id)).map((value) => cloneSafe(value));
  }

  getProvider(providerId: string): ProviderDescriptor {
    const provider = this.providers.get(providerId);
    if (!provider) throw new RuntimeError('UNKNOWN_PROVIDER', `Unknown model provider: ${providerId}`);
    return cloneSafe(provider);
  }

  listModels(providerId: string): readonly ModelDescriptor[] {
    const models = this.models.get(providerId);
    if (!models) throw new RuntimeError('UNKNOWN_PROVIDER', `Unknown model provider: ${providerId}`);
    return [...models.values()].sort((left, right) => left.route.modelId.localeCompare(right.route.modelId)).map((value) => cloneSafe(value));
  }

  resolveModel(route: ModelRoute): ModelDescriptor {
    const models = this.models.get(route.providerId);
    if (!models) throw new RuntimeError('UNKNOWN_PROVIDER', `Unknown model provider: ${route.providerId}`);
    const model = models.get(route.modelId);
    if (!model) throw new RuntimeError('UNKNOWN_MODEL', `Unknown model: ${route.providerId}/${route.modelId}`);
    return cloneSafe(model);
  }

  /** @internal Used by ModelRuntime; never included in public descriptors. */
  connectionFor(route: ModelRoute): unknown {
    return this.connections.get(modelRouteKey(route));
  }
}
