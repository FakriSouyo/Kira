import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCapabilityPlan } from '@harness/capability';
import { createJudgeExecutionProfile, createJudgeWorkflow, judgeWorkflowGraphFingerprint } from '@harness/command-judge';
import { planJudgeResume, type JudgeCheckpointStores } from '@harness/engine';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { createExecutionProfile } from '@harness/session-core';

let db: FinharnessDatabase;
let dir: string;
const capabilityPlan = createCapabilityPlan({ list: () => [] }, []);

function checkpointStores(): JudgeCheckpointStores {
  return {
    workflowNodeOutputs: db.workflowNodeOutputs,
    financialSnapshots: db.financialSnapshots,
    evidence: db.evidence,
    contextSnapshots: db.contextSnapshots,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-q2-resume-plan-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  if (db.raw.open) db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Q2 runtime-plan resume gate', () => {
  it('rejects semantic plan drift before acquisition while allowing the legacy provider/model fields', async () => {
    const session = await db.sessions.createSession({ sessionId: 'q2-plan-session', title: 'Q2 plan', provider: 'openrouter', model: 'qwen/qwen3', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ turnId: 'q2-plan-turn', sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const execution = await db.sessions.createExecution({ executionId: 'q2-plan-run', sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge' });
    const profile = createJudgeExecutionProfile({
      executionId: execution.id, ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3',
      runtimePlan: { runtimeFingerprint: 'a'.repeat(64), schemaVersion: 1, primary: null, fallbacks: [] },
      capabilityPlan,
      createdAt: execution.createdAt,
    });
    await db.executionProfiles.save(profile);

    await expect(planJudgeResume({
      stores: checkpointStores(), execution, profile, definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: 'openrouter', model: 'qwen/qwen3', runtimePlanFingerprint: 'b'.repeat(64), capabilityPlanFingerprint: capabilityPlan.fingerprint,
    })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    expect((await db.sessions.getSessionArtifacts(session.id)).executions[0]).toMatchObject({ status: 'running', resumeGeneration: 0 });
  });

  it('rejects a capability-semantic drift before acquisition', async () => {
    const session = await db.sessions.createSession({ sessionId: 'r2c2-cap-drift-session', title: 'R2C2 capability drift', provider: 'openrouter', model: 'qwen/qwen3', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ turnId: 'r2c2-cap-drift-turn', sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const execution = await db.sessions.createExecution({ executionId: 'r2c2-cap-drift-run', sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge' });
    const profile = createJudgeExecutionProfile({
      executionId: execution.id, ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3',
      capabilityPlan,
      createdAt: execution.createdAt,
    });
    await db.executionProfiles.save(profile);

    await expect(planJudgeResume({
      stores: checkpointStores(), execution, profile, definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: 'openrouter', model: 'qwen/qwen3', capabilityPlanFingerprint: '0'.repeat(64),
    })).rejects.toMatchObject({
      code: 'CAPABILITY_MISMATCH',
      message: expect.stringMatching(/authority|capability semantics/i),
    });
    expect((await db.sessions.getSessionArtifacts(session.id)).executions[0]).toMatchObject({ status: 'running', resumeGeneration: 0 });
  });

  it('rejects a pre-R2C2 capability-less Judge profile before model validation', async () => {
    const session = await db.sessions.createSession({ sessionId: 'r2c2-legacy-session', title: 'R2C2 legacy', provider: 'openrouter', model: 'qwen/qwen3', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ turnId: 'r2c2-legacy-turn', sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const execution = await db.sessions.createExecution({ executionId: 'r2c2-legacy-run', sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge' });
    const profile = createExecutionProfile({
      executionId: execution.id, ticker: 'BBCA', workflowId: 'judge', workflowVersion: 2,
      graphFingerprint: judgeWorkflowGraphFingerprint(), command: 'judge',
      payload: { reasoningMode: 'usual', conditional: false, researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3' },
      createdAt: execution.createdAt,
    });

    await expect(planJudgeResume({
      stores: checkpointStores(), execution, profile, definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: 'wrong-provider', model: 'wrong-model', capabilityPlanFingerprint: '0'.repeat(64),
    })).rejects.toMatchObject({
      code: 'INCOMPATIBLE_CHECKPOINT',
      message: expect.stringMatching(/capability-aware Judge resume|new \/judge/i),
    });
  });

  it('reaches the model mismatch gate when the current capability plan is valid', async () => {
    const session = await db.sessions.createSession({ sessionId: 'r2c2-model-drift-session', title: 'R2C2 model drift', provider: 'openrouter', model: 'qwen/qwen3', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ turnId: 'r2c2-model-drift-turn', sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const execution = await db.sessions.createExecution({ executionId: 'r2c2-model-drift-run', sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge' });
    const profile = createJudgeExecutionProfile({
      executionId: execution.id, ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3',
      capabilityPlan,
      createdAt: execution.createdAt,
    });

    await expect(planJudgeResume({
      stores: checkpointStores(), execution, profile, definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: 'openrouter', model: 'different-model', capabilityPlanFingerprint: capabilityPlan.fingerprint,
    })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
  });

  it('rejects a tampered persisted capability plan before interrupted execution acquisition', async () => {
    const session = await db.sessions.createSession({ sessionId: 'r2c2-tampered-plan-session', title: 'R2C2 tampered plan', provider: 'openrouter', model: 'qwen/qwen3', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ turnId: 'r2c2-tampered-plan-turn', sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const execution = await db.sessions.createExecution({ executionId: 'r2c2-tampered-plan-run', sessionId: session.id, turnId: turn.id, ticker: 'BBCA', command: 'judge' });
    const profile = createJudgeExecutionProfile({
      executionId: execution.id, ticker: 'BBCA', reasoningMode: 'usual', conditional: false,
      researchers: { market: true, news: true }, provider: 'openrouter', model: 'qwen/qwen3', capabilityPlan,
      createdAt: execution.createdAt,
    });
    await db.executionProfiles.save(profile);
    await db.sessions.interruptExecution(execution.id, 'test interruption');

    const tampered = createExecutionProfile({
      executionId: profile.executionId,
      workflowId: profile.workflowId,
      workflowVersion: profile.workflowVersion,
      graphFingerprint: profile.graphFingerprint,
      command: profile.command,
      ticker: profile.ticker,
      payload: {
        ...(profile.payload as Record<string, unknown>),
        capabilityPlan: { ...capabilityPlan, fingerprint: '0'.repeat(64) },
      } as never,
      createdAt: profile.createdAt,
    });
    db.raw.prepare('UPDATE execution_profiles SET payload_json = ?, fingerprint = ? WHERE execution_id = ?')
      .run(JSON.stringify(tampered.payload), tampered.fingerprint, execution.id);
    const persisted = await db.executionProfiles.getByExecutionId(execution.id);
    const acquire = vi.spyOn(db.sessions, 'acquireInterruptedExecution');
    const interrupted = (await db.sessions.getSessionArtifacts(session.id)).executions[0]!;

    await expect(planJudgeResume({
      stores: checkpointStores(), execution: interrupted, profile: persisted!, definition: createJudgeWorkflow(),
      currentGraphFingerprint: judgeWorkflowGraphFingerprint(), provider: 'openrouter', model: 'qwen/qwen3',
      capabilityPlanFingerprint: capabilityPlan.fingerprint,
    })).rejects.toMatchObject({ code: 'INCOMPATIBLE_CHECKPOINT' });
    expect(acquire).not.toHaveBeenCalled();
    expect((await db.sessions.getSessionArtifacts(session.id)).executions[0]).toMatchObject({ status: 'interrupted', resumeGeneration: 0 });
  });
});
