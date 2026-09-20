import { describe, expect, it } from 'vitest';
import { MockLLMClient } from '@harness/llm';
import { WorkflowTraceRecorder } from '../src/runtime/workflowTraceRecorder.js';

describe('WorkflowTraceRecorder', () => {
  it('persists lifecycle, skill hashes, model usage, duration, and explicit pricing', async () => {
    const steps: unknown[] = [];
    const calls: unknown[] = [];
    const store = {
      async saveStep(params: unknown) { steps.push(params); return params; },
      async recordModelCall(params: unknown) { calls.push(params); return params; },
    };
    const recorder = new WorkflowTraceRecorder({
      runId: 'run-1',
      definition: { id: 'research', nodes: [{ id: 'collect', label: 'Collect', executor: { kind: 'subagent', id: 'researcher' }, dependsOn: [], run: async () => undefined }] },
      store,
      pricingFor: () => ({ inputPerMillion: 2, outputPerMillion: 8, cachedInputPerMillion: 0.5, currency: 'USD' }),
    });

    await recorder.handle({ type: 'workflow.step.started', workflowId: 'research', nodeId: 'collect', label: 'Collect' });
    await recorder.recordSubagentResult('collect', {
      value: { summary: 'Sources collected.' }, subagent: 'researcher',
      skills: [{ name: 'source-research', contentHash: 'hash-v1' }],
      modelCall: {
        provider: 'openai', model: 'gpt-test', providerId: 'openai', modelId: 'gpt-test', adapterId: 'openai-compatible',
        protocol: 'openai-chat', runtimeFingerprint: 'a'.repeat(64), inputTokens: 1000, outputTokens: 500,
        cachedInputTokens: 200, totalTokens: 1500, finishReason: 'stop', latencyMs: 250,
      },
    });
    await recorder.handle({ type: 'workflow.step.completed', workflowId: 'research', nodeId: 'collect', label: 'Collect', durationMs: 300 });

    expect(steps.at(-1)).toMatchObject({ status: 'completed', durationMs: 300, subagent: 'researcher', skills: [{ name: 'source-research', contentHash: 'hash-v1' }] });
    expect(calls).toEqual([expect.objectContaining({
      providerId: 'openai', modelId: 'gpt-test', adapterId: 'openai-compatible', protocol: 'openai-chat',
      runtimeFingerprint: 'a'.repeat(64), totalTokens: 1500, cost: 0.0057, currency: 'USD', latencyMs: 250,
    })]);
  });

  it('fails closed when a context-backed result has no model metadata', async () => {
    const calls: unknown[] = [];
    const recorder = new WorkflowTraceRecorder({
      runId: 'run-missing-metadata',
      definition: { id: 'research', nodes: [{ id: 'collect', label: 'Collect', executor: { kind: 'subagent', id: 'researcher' }, dependsOn: [] }] },
      store: {
        async saveStep(params: unknown) { return params; },
        async recordModelCall(params: unknown) { calls.push(params); return params; },
      },
    });

    await expect(recorder.recordSubagentResult('collect', {
      value: { summary: 'unaudited' }, subagent: 'researcher', skills: [], contextSnapshotId: 'snapshot-1',
    } as never)).rejects.toMatchObject({ code: 'MODEL_METADATA_REQUIRED' });
    expect(calls).toEqual([]);
  });

  it('persists deterministic mock runtime metadata as actual invocation identity', async () => {
    const calls: unknown[] = [];
    const recorder = new WorkflowTraceRecorder({
      runId: 'run-mock-metadata',
      definition: { id: 'research', nodes: [{ id: 'collect', label: 'Collect', executor: { kind: 'subagent', id: 'researcher' }, dependsOn: [] }] },
      store: {
        async saveStep(params: unknown) { return params; },
        async recordModelCall(params: unknown) { calls.push(params); return params; },
      },
    });
    const result = await new MockLLMClient().generateObjectResult({
      schema: { parse: (value: unknown) => value } as never, system: 'Intent Router', prompt: 'route this',
    });

    await recorder.recordSubagentResult('collect', {
      value: result.value, subagent: 'researcher', skills: [], modelCall: result.metadata,
    });

    expect(calls).toEqual([expect.objectContaining({
      providerId: 'mock', modelId: 'deterministic-financial-mock', adapterId: 'mock', protocol: 'mock',
      runtimeFingerprint: result.metadata.runtimeFingerprint,
    })]);
  });
});
