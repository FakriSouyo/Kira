import type { GenerateObjectParams, GenerateTextParams, StreamObjectParams, StreamTextParams } from './types';
import { RuntimeError } from './errors';
import type { ModelAdapter, ModelInvocationResult, PreparedAdapterCall, PreparedTextStream } from './adapter';
import { createModelRuntimeDescriptor, type ModelGenerationControls, type ModelRuntimeDescriptor } from './descriptor';
import { ProviderDirectory, type ModelDescriptor, type ModelRoute } from './provider-directory';
import { createModelRuntimePlan, type ModelRuntimePlan, type ModelRuntimePlanRequest } from './plan';

export interface ModelRuntimeOptions {
  readonly directory: ProviderDirectory;
  readonly adapters: readonly ModelAdapter[];
}

export class PreparedModelCall {
  readonly descriptor: ModelRuntimeDescriptor;
  readonly model: ModelDescriptor;
  private used = false;

  constructor(model: ModelDescriptor, descriptor: ModelRuntimeDescriptor, private readonly call: PreparedAdapterCall) {
    this.model = model;
    this.descriptor = descriptor;
  }

  private begin(signal?: AbortSignal): void {
    if (this.used) throw new RuntimeError('PREPARED_CALL_ALREADY_USED', 'Prepared model calls can be dispatched only once');
    if (signal?.aborted) throw new RuntimeError('ABORTED', 'Model call was aborted before dispatch');
    this.used = true;
  }

  async generateObjectResult<T>(params: GenerateObjectParams<T>): Promise<ModelInvocationResult<T>> {
    this.begin(params.abortSignal);
    return this.call.generateObject(params);
  }

  async generateTextResult(params: GenerateTextParams): Promise<ModelInvocationResult<string>> {
    this.begin(params.abortSignal);
    return this.call.generateText(params);
  }

  streamText(params: StreamTextParams): PreparedTextStream {
    this.begin(params.abortSignal);
    return this.call.streamText(params);
  }

  async streamObjectResult<T>(params: StreamObjectParams<T>): Promise<ModelInvocationResult<T>> {
    this.begin(params.abortSignal);
    return this.call.streamObject(params);
  }
}

export class ModelRuntime {
  private directory: ProviderDirectory;
  private adapters: ReadonlyMap<string, ModelAdapter>;

  constructor(options: ModelRuntimeOptions) {
    this.directory = options.directory;
    this.adapters = ModelRuntime.adapterMap(options.adapters);
  }

  private static adapterMap(adapters: readonly ModelAdapter[]): ReadonlyMap<string, ModelAdapter> {
    const map = new Map<string, ModelAdapter>();
    for (const adapter of adapters) {
      if (map.has(adapter.id)) throw new RuntimeError('INVALID_RUNTIME_CONFIG', `Adapter ${adapter.id} is registered more than once`);
      map.set(adapter.id, adapter);
    }
    return map;
  }

  replaceDirectory(directory: ProviderDirectory): void {
    this.directory = directory;
  }

  replaceAdapters(adapters: readonly ModelAdapter[]): void {
    this.adapters = ModelRuntime.adapterMap(adapters);
  }

  private resolveCall(route: ModelRoute, generationControls: ModelGenerationControls): {
    model: ModelDescriptor;
    adapter: ModelAdapter;
    descriptor: ModelRuntimeDescriptor;
  } {
    const model = this.directory.resolveModel(route);
    const adapter = this.adapters.get(model.provider.adapterId);
    if (!adapter) throw new RuntimeError('UNKNOWN_ADAPTER', `Unknown model adapter: ${model.provider.adapterId}`);
    return {
      model,
      adapter,
      descriptor: createModelRuntimeDescriptor({ model, generationControls }),
    };
  }

  /** Resolves detached semantic runtime data and validates dispatch availability without preparing a call. */
  describeCall(route: ModelRoute, generationControls: ModelGenerationControls): ModelRuntimeDescriptor {
    return this.resolveCall(route, generationControls).descriptor;
  }

  describePlan(requests: readonly ModelRuntimePlanRequest[]): ModelRuntimePlan {
    return createModelRuntimePlan(requests.map(request => ({
      route: { ...request.route },
      descriptor: this.describeCall(request.route, request.generationControls),
    })));
  }

  prepareCall(route: ModelRoute, generationControls: ModelGenerationControls): PreparedModelCall {
    const resolved = this.resolveCall(route, generationControls);
    const prepared = resolved.adapter.prepareCall({
      model: resolved.model,
      descriptor: resolved.descriptor,
      connection: this.directory.connectionFor(route),
    });
    return new PreparedModelCall(resolved.model, resolved.descriptor, prepared);
  }
}
