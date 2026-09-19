import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createExecutionProfile,
  createWorkflowNodeOutput,
} from '@harness/session-core';
import { openDb, type FinharnessDatabase } from '@harness/database';

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-resumability-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

async function createLifecycle() {
  const session = await db.sessions.createSession({
    sessionId: 'session-resume', title: 'Resume', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
  });
  const turn = await db.sessions.createTurn({
    turnId: 'turn-resume', sessionId: session.id, input: '/judge BBCA', command: 'judge',
  });
  const execution = await db.sessions.createExecution({
    executionId: 'run-resume', sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge',
  });
  return { session, turn, execution };
}

describe('durable resumability persistence', () => {
  it('interrupts and reacquires one execution without creating a retry attempt', async () => {
    const { turn, execution } = await createLifecycle();

    const interrupted = await db.sessions.interruptExecution(execution.id, 'process exited unexpectedly');
    expect(interrupted).toMatchObject({ status: 'interrupted', resumeGeneration: 0, completedAt: null });
    await expect(db.sessions.settleTurn(turn.id, 'completed')).rejects.toThrow(/interrupted/);
    await expect(db.sessions.createExecution({
      sessionId: execution.sessionId, turnId: turn.id, ticker: 'BBCA', command: 'judge',
    })).rejects.toThrow(/interrupted execution/);

    const resumed = await db.sessions.acquireInterruptedExecution(execution.id);
    expect(resumed).toMatchObject({ status: 'running', attempt: 1, resumeGeneration: 1, error: null });
    await expect(db.sessions.acquireInterruptedExecution(execution.id)).rejects.toThrow(/cannot transition from running/);
  });

  it('persists immutable profiles and idempotent typed node outputs with generation fencing', async () => {
    const { execution } = await createLifecycle();
    const profile = createExecutionProfile({
      executionId: execution.id,
      workflowId: 'judge',
      workflowVersion: 1,
      graphFingerprint: 'b'.repeat(64),
      command: 'judge',
      ticker: 'BBCA',
      payload: { reasoningMode: 'usual', conditional: false },
      createdAt: '2026-09-19T00:00:00.000Z',
    });
    await expect(db.executionProfiles.save(profile)).resolves.toEqual(profile);
    await expect(db.executionProfiles.save(profile)).resolves.toEqual(profile);
    expect(await db.executionProfiles.getByExecutionId(execution.id)).toEqual(profile);

    const conflictingProfile = createExecutionProfile({ ...profile, payload: { reasoningMode: 'reasoning', conditional: false } });
    await expect(db.executionProfiles.save(conflictingProfile)).rejects.toMatchObject({ code: 'EXECUTION_PROFILE_CONFLICT' });

    const output = createWorkflowNodeOutput({
      outputId: 'output-research',
      executionId: execution.id,
      workflowId: 'judge',
      workflowVersion: 1,
      nodeId: 'research',
      status: 'completed',
      outputKind: 'json',
      dependencyFingerprint: 'a'.repeat(64),
      payload: { sourceCount: 2 },
      completionGeneration: 0,
      createdAt: '2026-09-19T00:00:00.000Z',
    });
    await expect(db.workflowNodeOutputs.save(output)).resolves.toEqual(output);
    const sameOutput = createWorkflowNodeOutput({ ...output, outputId: 'different-id', createdAt: '2026-09-19T00:01:00.000Z' });
    await expect(db.workflowNodeOutputs.save(sameOutput)).resolves.toEqual(output);
    const conflictingOutput = createWorkflowNodeOutput({ ...output, payload: { sourceCount: 3 } });
    await expect(db.workflowNodeOutputs.save(conflictingOutput)).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_CONFLICT' });
    expect(await db.workflowNodeOutputs.listNodeOutputsForExecution(execution.id)).toEqual([output]);

    await db.sessions.interruptExecution(execution.id);
    await db.sessions.acquireInterruptedExecution(execution.id);
    const stale = createWorkflowNodeOutput({ ...output, nodeId: 'other-node', outputId: 'output-other' });
    await expect(db.workflowNodeOutputs.save(stale)).rejects.toMatchObject({ code: 'WORKFLOW_OUTPUT_CONFLICT' });
  });
});
