import { APICallError, type LanguageModel } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createHash, randomUUID } from 'node:crypto';
import { sleep } from '@harness/shared';
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from './config';
import type { ModelInvocationMetadata, PreparedTextStream } from './adapter';
import { createAiSdkAdapter } from './adapters/ai-sdk';
import { ModelRuntime, type PreparedModelCall } from './model-runtime';
import { ProviderDirectory, type ModelCapabilities, type ModelRoute, type ProviderRegistration } from './provider-directory';
import { parseJsonResponse } from './sdk-helpers';
import type {
  GenerateObjectParams,
  GenerateTextParams,
  LLMCallMetadata,
  LLMClientLike,
  LLMModelConfig,
  LLMResult,
  LLMTextStreamResult,
  StreamObjectParams,
  StreamTextParams,
} from './types';

export { parseJsonResponse, toSystemPrompt } from './sdk-helpers';

export interface LLMClientOptions {
  config: LLMModelConfig;
  fallbackConfigs?: LLMModelConfig[];
  maxRetries?: number;
  retryBaseDelayMs?: number;
  modelFactory?: (config: LLMModelConfig) => LanguageModel;
}

export function createProvider(config: LLMModelConfig) {
  const options = { baseURL: config.baseURL, apiKey: config.apiKey };
  if (config.provider === 'anthropic') return createAnthropic(options);
  const responses = config.api === 'responses' || !config.api && config.baseURL?.includes('opencode.ai/zen');
  const sessionId = responses ? config.sessionId ?? randomUUID() : undefined;
  return createOpenAI({ ...options, ...(sessionId ? { headers: {
    session_id: sessionId, 'x-client-request-id': sessionId, 'user-agent': 'finharness',
  } } : {}) });
}

export function resolveModel(config: LLMModelConfig): LanguageModel {
  const provider = createProvider(config);
  const api = config.api ?? (config.baseURL?.includes('opencode.ai/zen') ? 'responses' : 'chat');
  if (api === 'responses') {
    const openai = provider as unknown as { responses: (model: string) => LanguageModel; chat: (model: string) => LanguageModel };
    if (typeof openai.responses === 'function') return openai.responses(config.model);
  }
  return (provider as { chat: (model: string) => LanguageModel }).chat(config.model);
}

export function classifyLLMError(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof APICallError) {
    const status = error.statusCode;
    if (status === 429) return { code: 'RATE_LIMIT', retryable: true };
    if (status === 408) return { code: 'TIMEOUT', retryable: true };
    if (status !== undefined && status >= 500) return { code: 'SERVER_ERROR', retryable: true };
    return { code: `HTTP_${status ?? 'ERROR'}`, retryable: false };
  }
  if (error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ETIMEDOUT')) {
    return { code: 'TIMEOUT', retryable: true };
  }
  const code = (error as { code?: string } | null)?.code;
  if (code === 'RATE_LIMIT' || code === 'TIMEOUT' || code === 'SERVER_ERROR') return { code, retryable: true };
  return { code: 'NON_RETRYABLE', retryable: false };
}

function endpointFingerprint(config: LLMModelConfig): string {
  const endpoint = config.baseURL?.trim().replace(/\/$/, '') ?? `${config.provider}:default`;
  return createHash('sha256').update(endpoint, 'utf8').digest('hex');
}

function protocolFor(config: LLMModelConfig): string {
  if (config.provider === 'anthropic') return 'anthropic-messages';
  return (config.api === 'responses' || (!config.api && config.baseURL?.includes('opencode.ai/zen'))) ? 'openai-responses' : 'openai-chat';
}

function adapterFor(config: LLMModelConfig): 'openai-compatible' | 'anthropic' {
  return config.provider === 'anthropic' ? 'anthropic' : 'openai-compatible';
}

function capabilitiesFor(config: LLMModelConfig): ModelCapabilities {
  return {
    contextWindowTokens: config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: config.maxTokens,
    supportsTextInput: true,
    supportsStructuredOutput: true,
    supportsTextStreaming: true,
    supportsStructuredStreaming: true,
    nativeStructuredOutput: config.api !== 'responses' || !config.baseURL,
  };
}

function legacyMetadata(config: LLMModelConfig, runtime: ModelInvocationMetadata): LLMCallMetadata {
  return {
    provider: config.provider,
    model: config.model,
    providerId: runtime.providerId,
    modelId: runtime.modelId,
    adapterId: runtime.adapterId,
    protocol: runtime.protocol,
    runtimeFingerprint: runtime.runtimeFingerprint,
    inputTokens: runtime.inputTokens,
    outputTokens: runtime.outputTokens,
    cachedInputTokens: runtime.cachedInputTokens,
    totalTokens: runtime.totalTokens,
    finishReason: runtime.finishReason,
    latencyMs: runtime.latencyMs,
  };
}

interface CompletedAttempt<T> {
  readonly result: T;
  readonly index: number;
}

export class LLMClient implements LLMClientLike {
  private readonly configs: LLMModelConfig[];
  private readonly routes: ModelRoute[];
  private readonly runtime: ModelRuntime;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: LLMClientOptions) {
    const primary = { ...options.config, sessionId: options.config.sessionId ?? randomUUID() };
    const configs = [primary, ...(options.fallbackConfigs ?? []).map((config) => ({ ...config, sessionId: config.sessionId ?? randomUUID() }))];
    this.configs = configs;
    this.routes = configs.map((config, index) => ({
      providerId: index === 0 ? config.provider : `${config.provider}#fallback-${index}`,
      modelId: config.model,
    }));
    const factory = options.modelFactory ?? resolveModel;
    const registrations: ProviderRegistration[] = configs.map((config, index) => {
      const adapterId = adapterFor(config);
      return {
        descriptor: {
          id: this.routes[index].providerId,
          displayName: config.provider,
          adapterId,
          protocol: protocolFor(config),
          endpointFingerprint: endpointFingerprint(config),
        },
        models: [{
          id: config.model,
          displayName: config.model,
          capabilities: capabilitiesFor(config),
          connection: { config, model: factory(config) },
        }],
      };
    });
    this.runtime = new ModelRuntime({
      directory: new ProviderDirectory(registrations),
      adapters: [createAiSdkAdapter('openai-compatible'), createAiSdkAdapter('anthropic')],
    });
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
  }

  private controlsFor(index: number) {
    return {
      temperature: this.configs[index].temperature,
      maxOutputTokens: this.configs[index].maxTokens,
    };
  }

  private prepare(index: number): PreparedModelCall {
    return this.runtime.prepareCall(this.routes[index], this.controlsFor(index));
  }

  /** Each retry and fallback route receives a new one-shot PreparedModelCall. */
  private async withRetry<T>(fn: (call: PreparedModelCall, index: number) => Promise<T>, signal?: AbortSignal): Promise<CompletedAttempt<T>> {
    let lastError: unknown;
    for (let modelIndex = 0; modelIndex < this.routes.length; modelIndex++) {
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        signal?.throwIfAborted();
        try {
          return { result: await fn(this.prepare(modelIndex), modelIndex), index: modelIndex };
        } catch (error) {
          signal?.throwIfAborted();
          lastError = error;
          const status = (error as { statusCode?: number })?.statusCode;
          const isAuthOrNotFound = status === 401 || status === 403 || status === 404;
          if (isAuthOrNotFound) break;
          const { retryable } = classifyLLMError(error);
          if (!retryable) break;
          if (attempt < this.maxRetries - 1) await sleep(this.retryBaseDelayMs * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  async generateObjectResult<T>(params: GenerateObjectParams<T>): Promise<LLMResult<T>> {
    try {
      const completed = await this.withRetry((call) => call.generateObjectResult(params), params.abortSignal);
      return {
        value: completed.result.value,
        metadata: legacyMetadata(this.configs[completed.index], completed.result.metadata),
      };
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      const msg = error instanceof Error ? error.message : String(error);
      const isSchemaUnsupported = status === 400 && (msg.includes('response_format') || msg.includes('json_schema'));
      if (!isSchemaUnsupported) throw error;
      const completed = await this.withRetry((call) => call.generateTextResult({
        prompt: `${params.prompt}\n\nIMPORTANT: Respond with valid JSON only, no markdown fences, no explanation.`,
        system: params.system,
        abortSignal: params.abortSignal,
      }).then((result) => ({
        value: parseJsonResponse(result.value, params.schema),
        metadata: result.metadata,
      })), params.abortSignal);
      return {
        value: completed.result.value,
        metadata: legacyMetadata(this.configs[completed.index], completed.result.metadata),
      };
    }
  }

  async generateObject<T>(params: GenerateObjectParams<T>): Promise<T> {
    return (await this.generateObjectResult(params)).value;
  }

  async streamObject<T>(params: StreamObjectParams<T>): Promise<T> {
    let lastError: unknown;
    for (let index = 0; index < this.routes.length; index++) {
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        let emitted = false;
        try {
          const result = await this.prepare(index).streamObjectResult({
            ...params,
            onPartial: (partial) => { emitted = true; params.onPartial?.(partial); },
          });
          return result.value;
        } catch (error) {
          params.abortSignal?.throwIfAborted();
          lastError = error;
          const status = (error as { statusCode?: number })?.statusCode;
          const msg = error instanceof Error ? error.message : String(error);
          if (!emitted && status === 400 && /stream|response_format|json_schema/i.test(msg)) {
            const output = await this.generateObject(params);
            params.onPartial?.(output as Partial<T>);
            return output;
          }
          const { retryable } = classifyLLMError(error);
          const isAuthOrNotFound = status === 401 || status === 403 || status === 404;
          if (emitted || (!retryable && !isAuthOrNotFound)) throw error;
          if (attempt < this.maxRetries - 1) await sleep(this.retryBaseDelayMs * 2 ** attempt);
        }
      }
    }
    throw lastError;
  }

  async generateTextResult(params: GenerateTextParams): Promise<LLMResult<string>> {
    const completed = await this.withRetry((call) => call.generateTextResult(params), params.abortSignal);
    return {
      value: completed.result.value,
      metadata: legacyMetadata(this.configs[completed.index], completed.result.metadata),
    };
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    return (await this.generateTextResult(params)).value;
  }

  streamTextResult(params: StreamTextParams): LLMTextStreamResult {
    const call = this.prepare(0);
    const stream: PreparedTextStream = call.streamText(params);
    return {
      chunks: stream.chunks,
      metadata: stream.metadata.then((value) => legacyMetadata(this.configs[0], value)),
    };
  }

  streamText(params: StreamTextParams): AsyncIterable<string> {
    return this.streamTextResult(params).chunks;
  }
}
