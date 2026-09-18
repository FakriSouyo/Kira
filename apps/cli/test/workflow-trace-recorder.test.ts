import { describe, expect, it } from 'vitest';
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
      modelCall: { provider: 'openai', model: 'gpt-test', inputTokens: 1000, outputTokens: 500, cachedInputTokens: 200, totalTokens: 1500, finishReason: 'stop', latencyMs: 250 },
    });
    await recorder.handle({ type: 'workflow.step.completed', workflowId: 'research', nodeId: 'collect', label: 'Collect', durationMs: 300 });

    expect(steps.at(-1)).toMatchObject({ status: 'completed', durationMs: 300, subagent: 'researcher', skills: [{ name: 'source-research', contentHash: 'hash-v1' }] });
    expect(calls).toEqual([expect.objectContaining({ totalTokens: 1500, cost: 0.0057, currency: 'USD', latencyMs: 250 })]);
  });
});
