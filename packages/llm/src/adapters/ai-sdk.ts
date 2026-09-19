import { generateObject, generateText, streamObject, streamText, zodSchema, type LanguageModel } from 'ai';
import type {
  GenerateObjectParams,
  GenerateTextParams,
  StreamObjectParams,
  StreamTextParams,
} from '../types';
import type {
  ModelAdapter,
  ModelInvocationMetadata,
  ModelInvocationResult,
  PreparedAdapterCall,
  PreparedTextStream,
} from '../adapter';
import type { ModelRuntimeDescriptor } from '../descriptor';
import { parseJsonResponse, responseTokenBudget, toSystemPrompt } from '../sdk-helpers';

interface AiSdkConnection {
  readonly config: {
    readonly provider: 'openai' | 'anthropic';
    readonly model: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly sessionId?: string;
    readonly baseURL?: string;
    readonly api?: 'chat' | 'responses';
  };
  readonly model: LanguageModel;
}

function metadata(
  descriptor: ModelRuntimeDescriptor,
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens?: number } | undefined,
  finishReason: string | undefined,
  started: number,
): ModelInvocationMetadata {
  return {
    providerId: descriptor.providerId,
    modelId: descriptor.modelId,
    adapterId: descriptor.adapterId,
    protocol: descriptor.protocol,
    runtimeFingerprint: descriptor.runtimeFingerprint,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
    finishReason: finishReason ?? null,
    latencyMs: performance.now() - started,
  };
}

function isResponses(config: AiSdkConnection['config']): boolean {
  return config.api === 'responses' || (!config.api && config.baseURL?.includes('opencode.ai/zen') === true);
}

export function createAiSdkAdapter(id: 'openai-compatible' | 'anthropic'): ModelAdapter {
  return {
    id,
    prepareCall({ descriptor, connection }): PreparedAdapterCall {
      if (!connection || typeof connection !== 'object' || !('config' in connection) || !('model' in connection)) {
        throw new Error(`Missing AI SDK connection for ${descriptor.providerId}/${descriptor.modelId}`);
      }
      const { config: sourceConfig, model: capturedModel } = connection as AiSdkConnection;
      // A prepared call owns a private configuration snapshot as well as the
      // safe public descriptor. Later compatibility/config changes cannot
      // alter endpoint, protocol, or generation controls for this call.
      const config = { ...sourceConfig };
      const model = capturedModel;
      return {
        async generateObject<T>(params: GenerateObjectParams<T>): Promise<ModelInvocationResult<T>> {
          const started = performance.now();
          if (config.api === 'responses' && config.baseURL) {
            const schemaJson = JSON.stringify(zodSchema(params.schema).jsonSchema);
            const streamed = streamText({
              maxRetries: 0,
              model,
              prompt: `${params.prompt}\n\nReturn exactly one valid JSON object matching this JSON Schema. Do not use markdown or add commentary.\n${schemaJson}`,
              system: toSystemPrompt(params.system, config.provider),
              abortSignal: params.abortSignal,
              temperature: config.temperature,
              maxOutputTokens: responseTokenBudget(config, true),
              providerOptions: { openai: { store: false, ...(config.sessionId ? { promptCacheKey: config.sessionId } : {}) } },
            });
            for await (const part of streamed.fullStream) if (part.type === 'error') throw part.error;
            const [text, usage, finishReason] = await Promise.all([streamed.text, streamed.usage, streamed.finishReason]);
            return { value: parseJsonResponse(text, params.schema), metadata: metadata(descriptor, usage, finishReason, started) };
          }
          const request = {
            maxRetries: 0,
            model,
            schema: params.schema,
            prompt: params.prompt,
            system: toSystemPrompt(params.system, config.provider),
            abortSignal: params.abortSignal,
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
          };
          if (config.api === 'responses') {
            let failure: unknown;
            const streamed = streamObject({
              ...request,
              providerOptions: { openai: { store: false, ...(config.sessionId ? { promptCacheKey: config.sessionId } : {}) } },
              onError: event => { failure = event.error; },
            });
            try {
              const [value, usage, finishReason] = await Promise.all([streamed.object, streamed.usage, streamed.finishReason]);
              return { value: value as T, metadata: metadata(descriptor, usage, finishReason, started) };
            } catch (error) {
              throw failure ?? error;
            }
          }
          const result = await generateObject(request);
          return { value: result.object as T, metadata: metadata(descriptor, result.usage, result.finishReason, started) };
        },

        async generateText(params: GenerateTextParams): Promise<ModelInvocationResult<string>> {
          const started = performance.now();
          const request = {
            maxRetries: 0,
            model,
            prompt: params.prompt,
            abortSignal: params.abortSignal,
            system: toSystemPrompt(params.system, config.provider),
            temperature: config.temperature,
            maxOutputTokens: responseTokenBudget(config, false),
          };
          if (isResponses(config)) {
            let failure: unknown;
            const response = streamText({
              ...request,
              providerOptions: { openai: { store: false, ...(config.sessionId ? { promptCacheKey: config.sessionId } : {}) } },
              onError: event => { failure = event.error; },
            });
            for await (const part of response.fullStream) if (part.type === 'error') throw failure ?? part.error;
            const [value, usage, finishReason] = await Promise.all([response.text, response.usage, response.finishReason]);
            return { value, metadata: metadata(descriptor, usage, finishReason, started) };
          }
          const result = await generateText(request);
          return { value: result.text, metadata: metadata(descriptor, result.usage, result.finishReason, started) };
        },

        streamText(params: StreamTextParams): PreparedTextStream {
          const started = performance.now();
          const request = {
            model,
            prompt: params.prompt,
            abortSignal: params.abortSignal,
            system: toSystemPrompt(params.system, config.provider),
            temperature: config.temperature,
            maxOutputTokens: responseTokenBudget(config, false),
          };
          const result = streamText({
            ...request,
            ...(isResponses(config) ? { providerOptions: { openai: { store: false, ...(config.sessionId ? { promptCacheKey: config.sessionId } : {}) } } } : {}),
          });
          return {
            chunks: result.textStream,
            metadata: Promise.all([result.usage, result.finishReason]).then(([usage, finishReason]) => metadata(descriptor, usage, finishReason, started)),
          };
        },

        async streamObject<T>(params: StreamObjectParams<T>): Promise<ModelInvocationResult<T>> {
          const started = performance.now();
          let failure: unknown;
          const result = streamObject({
            model,
            maxRetries: 0,
            schema: params.schema,
            prompt: params.prompt,
            abortSignal: params.abortSignal,
            system: toSystemPrompt(params.system, config.provider),
            temperature: config.temperature,
            maxOutputTokens: config.maxTokens,
            ...(isResponses(config) ? { providerOptions: { openai: { store: false, ...(config.sessionId ? { promptCacheKey: config.sessionId } : {}) } } } : {}),
            onError: event => { failure = event.error; },
          });
          try {
            void result.object.catch(() => undefined);
            for await (const partial of result.partialObjectStream) params.onPartial?.(partial as Partial<T>);
            const [value, usage, finishReason] = await Promise.all([result.object, result.usage, result.finishReason]);
            return { value: value as T, metadata: metadata(descriptor, usage, finishReason, started) };
          } catch (error) {
            throw failure ?? error;
          }
        },
      };
    },
  };
}
