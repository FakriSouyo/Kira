import type { GenerateObjectParams, GenerateTextParams, StreamObjectParams, StreamTextParams } from './types';
import type { ModelRuntimeDescriptor } from './descriptor';
import type { ModelDescriptor } from './provider-directory';

export interface ModelInvocationMetadata {
  readonly providerId: string;
  readonly modelId: string;
  readonly adapterId: string;
  readonly protocol: string;
  readonly runtimeFingerprint: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string | null;
  readonly latencyMs: number;
}

export interface ModelInvocationResult<T> {
  readonly value: T;
  readonly metadata: ModelInvocationMetadata;
}

export interface PreparedTextStream {
  readonly chunks: AsyncIterable<string>;
  readonly metadata: Promise<ModelInvocationMetadata>;
}

export interface PreparedAdapterCall {
  generateObject<T>(params: GenerateObjectParams<T>): Promise<ModelInvocationResult<T>>;
  generateText(params: GenerateTextParams): Promise<ModelInvocationResult<string>>;
  streamText(params: StreamTextParams): PreparedTextStream;
  streamObject<T>(params: StreamObjectParams<T>): Promise<ModelInvocationResult<T>>;
}

export interface ModelAdapter {
  readonly id: string;
  prepareCall(params: {
    readonly model: ModelDescriptor;
    readonly descriptor: ModelRuntimeDescriptor;
    readonly connection?: unknown;
  }): PreparedAdapterCall;
}

