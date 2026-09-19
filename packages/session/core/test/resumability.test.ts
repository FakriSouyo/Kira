import { describe, expect, it } from 'vitest';
import {
  createExecutionProfile,
  createWorkflowNodeOutput,
} from '../src/index.js';

describe('durable resumability envelopes', () => {
  it('creates a stable execution profile fingerprint from semantic fields', () => {
    const params = {
      executionId: 'run-1',
      workflowId: 'judge',
      workflowVersion: 1,
      graphFingerprint: 'graph-1',
      command: 'judge',
      ticker: 'BBCA',
      payload: { reasoningMode: 'usual', conditional: false },
      createdAt: '2026-09-19T00:00:00.000Z',
    } as const;

    const first = createExecutionProfile(params);
    const second = createExecutionProfile({ ...params, createdAt: '2026-09-19T00:01:00.000Z' });

    expect(first.schemaVersion).toBe(1);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first).not.toEqual(second);
  });

  it('creates immutable node output identities for completed and skipped envelopes', () => {
    const completed = createWorkflowNodeOutput({
      outputId: 'output-1',
      executionId: 'run-1',
      workflowId: 'judge',
      workflowVersion: 1,
      nodeId: 'research',
      status: 'completed',
      outputKind: 'json',
      dependencyFingerprint: 'deps-1',
      payload: { sourceCount: 2 },
      completionGeneration: 0,
      createdAt: '2026-09-19T00:00:00.000Z',
    });
    const skipped = createWorkflowNodeOutput({
      executionId: 'run-1',
      workflowId: 'judge',
      workflowVersion: 1,
      nodeId: 'debate',
      status: 'skipped',
      outputKind: 'disabled',
      dependencyFingerprint: 'deps-1',
      payload: null,
      completionGeneration: 0,
      createdAt: '2026-09-19T00:00:00.000Z',
    });

    expect(completed.outputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(completed.outputId).toBe('output-1');
    expect(skipped.status).toBe('skipped');
    expect(skipped.payload).toBeNull();
  });

  it('rejects non-data payloads', () => {
    expect(() => createExecutionProfile({
      executionId: 'run-1', workflowId: 'judge', workflowVersion: 1, graphFingerprint: 'graph-1',
      command: 'judge', ticker: 'BBCA', payload: { callback: () => 'nope' }, createdAt: '2026-09-19T00:00:00.000Z',
    } as never)).toThrow(/JSON|data-only|serializable/i);
  });
});
