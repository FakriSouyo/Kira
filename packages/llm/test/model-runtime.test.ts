import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLanguageModelV2 } from 'ai/test';
import { createAiSdkAdapter } from '../src/adapters/ai-sdk';
import {
  ModelRuntime,
  ProviderDirectory,
  RuntimeError,
  createModelRuntimeDescriptor,
  type ModelAdapter,
  type ModelCapabilities,
  type PreparedAdapterCall,
  type ProviderRegistration,
  type GenerateObjectParams,
  type StreamObjectParams,
  sameModelRoute,
  modelRouteKey,
} from '../src/index';

const capabilities: ModelCapabilities = {
  contextWindowTokens: 128_000,
  maxOutputTokens: 4_096,
  supportsTextInput: true,
  supportsStructuredOutput: true,
  supportsTextStreaming: true,
  supportsStructuredStreaming: true,
  nativeStructuredOutput: true,
};

function provider(id: string, endpointFingerprint = 'endpoint-a', connection?: Record<string, unknown>): ProviderRegistration {
  return {
    descriptor: {
      id,
      displayName: id,
      adapterId: 'fake-adapter',
      protocol: 'fake-protocol',
      endpointFingerprint,
    },
    models: [{ id: 'model-a', displayName: 'Model A', capabilities, connection }],
  };
}

function metadata(call: { runtimeFingerprint: string; providerId: string; modelId: string; adapterId: string; protocol: string }) {
  return {
    ...call,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    totalTokens: null,
    finishReason: 'stop',
    latencyMs: 0,
  };
}

class RecordingAdapter implements ModelAdapter {
  readonly id = 'fake-adapter';
  readonly prepared: Array<{ endpointFingerprint?: string; modelId: string }> = [];
  readonly invocations: string[] = [];

  prepareCall(params: Parameters<ModelAdapter['prepareCall']>[0]): PreparedAdapterCall {
    this.prepared.push({
      endpointFingerprint: params.model.provider.endpointFingerprint,
      modelId: params.model.route.modelId,
    });
    const descriptor = params.descriptor;
    return {
      generateObject: async <T>(request: GenerateObjectParams<T>) => {
        this.invocations.push('object');
        return {
          value: request.schema.parse({ answer: 'ok' }) as T,
          metadata: metadata({
            runtimeFingerprint: descriptor.runtimeFingerprint,
            providerId: descriptor.providerId,
            modelId: descriptor.modelId,
            adapterId: descriptor.adapterId,
            protocol: descriptor.protocol,
          }),
        };
      },
      generateText: async () => {
        this.invocations.push('text');
        return {
          value: `${descriptor.providerId}:${descriptor.modelId}:${descriptor.endpointFingerprint}`,
          metadata: metadata({
            runtimeFingerprint: descriptor.runtimeFingerprint,
            providerId: descriptor.providerId,
            modelId: descriptor.modelId,
            adapterId: descriptor.adapterId,
            protocol: descriptor.protocol,
          }),
        };
      },
      streamText: () => {
        this.invocations.push('stream-text');
        return {
          chunks: (async function* () { yield 'chunk'; })(),
          metadata: Promise.resolve(metadata({
            runtimeFingerprint: descriptor.runtimeFingerprint,
            providerId: descriptor.providerId,
            modelId: descriptor.modelId,
            adapterId: descriptor.adapterId,
            protocol: descriptor.protocol,
          })),
        };
      },
      streamObject: async <T>(request: StreamObjectParams<T>) => {
        this.invocations.push('stream-object');
        return {
          value: request.schema.parse({ answer: 'ok' }) as T,
          metadata: metadata({
            runtimeFingerprint: descriptor.runtimeFingerprint,
            providerId: descriptor.providerId,
            modelId: descriptor.modelId,
            adapterId: descriptor.adapterId,
            protocol: descriptor.protocol,
          }),
        };
      },
    };
  }
}

describe('ProviderDirectory', () => {
  it('provides canonical route equality and keys', () => {
    expect(sameModelRoute({ providerId: 'p', modelId: 'm' }, { providerId: 'p', modelId: 'm' })).toBe(true);
    expect(sameModelRoute({ providerId: 'p', modelId: 'm' }, { providerId: 'p2', modelId: 'm' })).toBe(false);
    expect(modelRouteKey({ providerId: 'p', modelId: 'm' })).toBe('p\u0000m');
  });

  it('represents many models and arbitrary logical providers with deterministic detached output', () => {
    const directory = new ProviderDirectory([
      {
        ...provider('local-vllm'),
        models: [
          { id: 'qwen', displayName: 'Qwen', capabilities },
          { id: 'model-a', displayName: 'Model A', capabilities },
        ],
      },
      provider('openrouter'),
      provider('anthropic'),
      provider('openai'),
    ]);

    expect(directory.listProviders().map((item) => item.id)).toEqual(['anthropic', 'local-vllm', 'openai', 'openrouter']);
    expect(directory.listModels('local-vllm').map((item) => item.route.modelId)).toEqual(['model-a', 'qwen']);
    expect(directory.resolveModel({ providerId: 'openrouter', modelId: 'model-a' }).route).toEqual({ providerId: 'openrouter', modelId: 'model-a' });
    expect(Object.isFrozen(directory.listProviders()[0])).toBe(true);
    expect(Object.isFrozen(directory.resolveModel({ providerId: 'openrouter', modelId: 'model-a' }).capabilities)).toBe(true);
  });

  it('rejects duplicates and distinguishes unknown providers from unknown models', () => {
    expect(() => new ProviderDirectory([provider('duplicate'), provider('duplicate')])).toThrowError(/DUPLICATE_PROVIDER/);
    expect(() => new ProviderDirectory([{
      ...provider('one'),
      models: [{ id: 'same', capabilities }, { id: 'same', capabilities }],
    }])).toThrowError(/DUPLICATE_MODEL/);
    const directory = new ProviderDirectory([provider('known')]);
    expect(() => directory.resolveModel({ providerId: 'missing', modelId: 'model-a' })).toThrowError(/UNKNOWN_PROVIDER/);
    expect(() => directory.resolveModel({ providerId: 'known', modelId: 'missing' })).toThrowError(/UNKNOWN_MODEL/);
  });

  it('does not expose private connection settings through safe descriptors', () => {
    const directory = new ProviderDirectory([provider('secret-provider', 'endpoint-a', {
      apiKey: 'do-not-leak', sessionId: 'opaque-session', baseURL: 'https://private.test',
    })]);
    const safe = directory.resolveModel({ providerId: 'secret-provider', modelId: 'model-a' });
    expect(JSON.stringify(safe)).not.toContain('do-not-leak');
    expect(JSON.stringify(safe)).not.toContain('opaque-session');
    expect(JSON.stringify(safe)).not.toContain('private.test');
  });

  it('preserves exact per-model capabilities instead of applying global defaults', () => {
    const exact = { ...capabilities, contextWindowTokens: 32_768, maxOutputTokens: 777, nativeStructuredOutput: false };
    const directory = new ProviderDirectory([{
      ...provider('exact-capabilities'),
      models: [{ id: 'custom-model', displayName: 'Custom', capabilities: exact }],
    }]);
    expect(directory.resolveModel({ providerId: 'exact-capabilities', modelId: 'custom-model' }).capabilities).toEqual(exact);
  });
});

describe('ModelRuntimeDescriptor', () => {
  it('fingerprints semantic runtime identity deterministically and excludes secrets', () => {
    const model = new ProviderDirectory([provider('openrouter', 'endpoint-a')]).resolveModel({ providerId: 'openrouter', modelId: 'model-a' });
    const left = createModelRuntimeDescriptor({ model, generationControls: { temperature: 0.2, maxOutputTokens: 100 } });
    const right = createModelRuntimeDescriptor({ model, generationControls: { temperature: 0.2, maxOutputTokens: 100 } });
    expect(left.runtimeFingerprint).toBe(right.runtimeFingerprint);
    expect(JSON.stringify(left)).not.toContain('apiKey');
    expect(JSON.stringify(left)).not.toContain('sessionId');
    expect(createModelRuntimeDescriptor({ model, generationControls: { temperature: 0.7, maxOutputTokens: 100 } }).runtimeFingerprint)
      .not.toBe(left.runtimeFingerprint);
    const otherEndpoint = new ProviderDirectory([provider('openrouter', 'endpoint-b')]).resolveModel({ providerId: 'openrouter', modelId: 'model-a' });
    expect(createModelRuntimeDescriptor({ model: otherEndpoint, generationControls: { temperature: 0.2, maxOutputTokens: 100 } }).runtimeFingerprint)
      .not.toBe(left.runtimeFingerprint);
    const otherCapability = new ProviderDirectory([{
      ...provider('openrouter', 'endpoint-a'),
      models: [{ id: 'model-a', capabilities: { ...capabilities, contextWindowTokens: 32_000 } }],
    }]).resolveModel({ providerId: 'openrouter', modelId: 'model-a' });
    expect(createModelRuntimeDescriptor({ model: otherCapability, generationControls: { temperature: 0.2, maxOutputTokens: 100 } }).runtimeFingerprint)
      .not.toBe(left.runtimeFingerprint);

    const secretA = new ProviderDirectory([provider('secret-rotation', 'endpoint-a', { apiKey: 'key-a', sessionId: 'session-a' })])
      .resolveModel({ providerId: 'secret-rotation', modelId: 'model-a' });
    const secretB = new ProviderDirectory([provider('secret-rotation', 'endpoint-a', { apiKey: 'key-b', sessionId: 'session-b' })])
      .resolveModel({ providerId: 'secret-rotation', modelId: 'model-a' });
    expect(createModelRuntimeDescriptor({ model: secretA, generationControls: { temperature: 0.2, maxOutputTokens: 100 } }).runtimeFingerprint)
      .toBe(createModelRuntimeDescriptor({ model: secretB, generationControls: { temperature: 0.2, maxOutputTokens: 100 } }).runtimeFingerprint);
  });
});

describe('ModelRuntime prepared calls', () => {
  it('AI SDK adapters capture private generation config at prepare time', async () => {
    let temperature: number | undefined;
    const model = new MockLanguageModelV2({
      doGenerate: async (options) => {
        temperature = (options as { temperature?: number }).temperature;
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
          warnings: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
    });
    const config = { provider: 'openai' as const, model: 'model-a', temperature: 0.2, maxTokens: 100 };
    const runtime = new ModelRuntime({
      directory: new ProviderDirectory([{
        descriptor: { id: 'openai', displayName: 'OpenAI', adapterId: 'openai-compatible', protocol: 'openai-chat', endpointFingerprint: 'default' },
        models: [{ id: 'model-a', capabilities, connection: { config, model } }],
      }]),
      adapters: [createAiSdkAdapter('openai-compatible')],
    });
    const call = runtime.prepareCall({ providerId: 'openai', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });
    config.temperature = 0.9;
    await call.generateTextResult({ prompt: 'snapshot' });
    expect(temperature).toBe(0.2);
  });

  it('captures directory generation A before replacement and uses generation A at dispatch', async () => {
    const adapter = new RecordingAdapter();
    const runtime = new ModelRuntime({ directory: new ProviderDirectory([provider('route-a', 'endpoint-a')]), adapters: [adapter] });
    const preparedA = runtime.prepareCall({ providerId: 'route-a', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });

    runtime.replaceDirectory(new ProviderDirectory([provider('route-a', 'endpoint-b')]));
    const resultA = await preparedA.generateTextResult({ prompt: 'first' });
    const preparedB = runtime.prepareCall({ providerId: 'route-a', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });
    const resultB = await preparedB.generateTextResult({ prompt: 'second' });

    expect(resultA.value).toContain('endpoint-a');
    expect(resultB.value).toContain('endpoint-b');
    expect(adapter.prepared).toEqual([
      { endpointFingerprint: 'endpoint-a', modelId: 'model-a' },
      { endpointFingerprint: 'endpoint-b', modelId: 'model-a' },
    ]);
  });

  it('is one-shot and checks abort before invoking the adapter', async () => {
    const adapter = new RecordingAdapter();
    const runtime = new ModelRuntime({ directory: new ProviderDirectory([provider('route-a')]), adapters: [adapter] });
    const prepared = runtime.prepareCall({ providerId: 'route-a', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });
    await prepared.generateTextResult({ prompt: 'first' });
    await expect(prepared.generateTextResult({ prompt: 'second' })).rejects.toMatchObject({ code: 'PREPARED_CALL_ALREADY_USED' });

    const controller = new AbortController();
    controller.abort();
    const aborted = runtime.prepareCall({ providerId: 'route-a', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });
    await expect(aborted.generateTextResult({ prompt: 'aborted', abortSignal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(adapter.invocations).toEqual(['text']);
  });

  it('keeps fallback above the prepared-call boundary', async () => {
    const first = new RecordingAdapter();
    const second = new RecordingAdapter();
    const runtimeA = new ModelRuntime({ directory: new ProviderDirectory([provider('provider-a')]), adapters: [first] });
    const runtimeB = new ModelRuntime({ directory: new ProviderDirectory([provider('provider-b')]), adapters: [second] });
    const callA = runtimeA.prepareCall({ providerId: 'provider-a', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });
    const callB = runtimeB.prepareCall({ providerId: 'provider-b', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });

    expect(callA.descriptor.providerId).toBe('provider-a');
    expect(callB.descriptor.providerId).toBe('provider-b');
    await expect(callA.generateObjectResult({ schema: z.object({ answer: z.string() }), prompt: 'first' })).resolves.toMatchObject({ value: { answer: 'ok' } });
    await expect(callB.generateTextResult({ prompt: 'fallback' })).resolves.toMatchObject({ value: expect.stringContaining('provider-b') });
    expect(first.invocations).toEqual(['object']);
    expect(second.invocations).toEqual(['text']);
  });

  it('returns actual metadata for structured streaming through the prepared call', async () => {
    const adapter = new RecordingAdapter();
    const runtime = new ModelRuntime({ directory: new ProviderDirectory([provider('route-a')]), adapters: [adapter] });
    const call = runtime.prepareCall({ providerId: 'route-a', modelId: 'model-a' }, { temperature: 0.2, maxOutputTokens: 100 });
    const result = await call.streamObjectResult({ schema: z.object({ answer: z.string() }), prompt: 'structured stream' });
    expect(result.value).toEqual({ answer: 'ok' });
    expect(result.metadata).toEqual(expect.objectContaining({
      providerId: 'route-a', modelId: 'model-a', adapterId: 'fake-adapter', protocol: 'fake-protocol',
    }));
  });
});

describe('Model runtime errors', () => {
  it('exposes stable typed error codes', () => {
    expect(new RuntimeError('UNKNOWN_PROVIDER', 'missing').code).toBe('UNKNOWN_PROVIDER');
    expect(new RuntimeError('UNKNOWN_MODEL', 'missing').name).toBe('ModelRuntimeError');
  });
});
