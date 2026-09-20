import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJudgeExecutionProfile, createJudgeWorkflow, judgeWorkflowGraphFingerprint } from '@harness/command-judge';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { planJudgeResume } from '../src/workflows/judgeCheckpoint';

let db: FinharnessDatabase;
let dir: string;

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
      createdAt: execution.createdAt,
    });
    await db.executionProfiles.save(profile);

    await expect(planJudgeResume({
      db, execution, profile, definition: createJudgeWorkflow(), currentGraphFingerprint: judgeWorkflowGraphFingerprint(),
      provider: 'openrouter', model: 'qwen/qwen3', runtimePlanFingerprint: 'b'.repeat(64),
    })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    expect((await db.sessions.getSessionArtifacts(session.id)).executions[0]).toMatchObject({ status: 'running', resumeGeneration: 0 });
  });
});
