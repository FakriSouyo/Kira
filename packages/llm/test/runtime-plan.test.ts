import { describe, expect, it } from 'vitest';
import { ModelRuntime } from '../src/model-runtime';
import { ProviderDirectory } from '../src/provider-directory';
import { LLMClient } from '../src/client';
import { MockLanguageModelV2 } from 'ai/test';

const capabilities = {
  contextWindowTokens: 16_384,
  maxOutputTokens: 2_000,
  supportsTextInput: true,
  supportsStructuredOutput: true,
  supportsTextStreaming: true,
  supportsStructuredStreaming: true,
  nativeStructuredOutput: true,
};

function runtime(): ModelRuntime {
  return new ModelRuntime({
    directory: new ProviderDirectory([
      {
        descriptor: { id: 'openrouter', displayName: 'OpenRouter', adapterId: 'openai-compatible', protocol: 'openai-chat', endpointFingerprint: 'endpoint-a' },
        models: [{ id: 'qwen/qwen3', capabilities }],
      },
      {
        descriptor: { id: 'anthropic', displayName: 'Anthropic', adapterId: 'anthropic', protocol: 'anthropic-messages', endpointFingerprint: 'endpoint-b' },
        models: [{ id: 'claude-sonnet', capabilities }],
      },
    ]),
    adapters: [],
  });
}

const controls = { temperature: 0.2, maxOutputTokens: 2_000 };

describe('side-effect-free execution runtime plans', () => {
  it('keeps logical provider identity distinct from the OpenAI-compatible adapter family', () => {
    const client = new LLMClient({
      config: {
        providerId: 'openrouter', provider: 'openai', model: 'qwen/qwen3', temperature: 0.2, maxTokens: 512,
        baseURL: 'https://openrouter.ai/api/v1', apiKey: 'secret',
      },
      modelFactory: () => new MockLanguageModelV2({ doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', warnings: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }) }),
    });

    expect(client.describeRuntimePlan().primary.descriptor).toEqual(expect.objectContaining({
      providerId: 'openrouter', adapterId: 'openai-compatible', protocol: 'openai-chat',
    }));
  });

  it('describes primary and fallback routes without constructing an adapter call', () => {
    const plan = runtime().describePlan([
      { route: { providerId: 'openrouter', modelId: 'qwen/qwen3' }, generationControls: controls },
      { route: { providerId: 'anthropic', modelId: 'claude-sonnet' }, generationControls: controls },
    ]);

    expect(plan.primary.descriptor.providerId).toBe('openrouter');
    expect(plan.fallbacks[0]?.descriptor.providerId).toBe('anthropic');
    expect(plan.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes the plan fingerprint when the semantic route, capability, or generation changes', () => {
    const first = runtime().describePlan([{ route: { providerId: 'openrouter', modelId: 'qwen/qwen3' }, generationControls: controls }]);
    const otherRoute = runtime().describePlan([{ route: { providerId: 'anthropic', modelId: 'claude-sonnet' }, generationControls: controls }]);
    const otherControls = runtime().describePlan([{ route: { providerId: 'openrouter', modelId: 'qwen/qwen3' }, generationControls: { ...controls, temperature: 0.7 } }]);

    expect(otherRoute.runtimeFingerprint).not.toBe(first.runtimeFingerprint);
    expect(otherControls.runtimeFingerprint).not.toBe(first.runtimeFingerprint);
  });
});
