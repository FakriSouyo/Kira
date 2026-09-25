import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { JUDGE_WORKFLOW_VERSION, judgeWorkflowGraphFingerprint } from '@harness/command-judge';
import { ConversationController } from '../src/ui/conversationController';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';

describe('PR O durable resumability foundation', () => {
  let homeDir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-resumability-cli-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('captures the canonical judge profile before the first provider operation', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const context = buildContext(db, config, { sessionId: 'resumability-test-session' });
    const session = await db.sessions.createSession({
      title: 'Profile capture', provider: config.llm.agent.provider, model: config.llm.agent.model, reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const save = vi.spyOn(db.executionProfiles, 'save');
    const provider = vi.spyOn(context.financialData, 'getCompanyReport');

    const result = await judgeWorkflow(context, 'BBCA', () => {}, () => {}, {
      conditional: true,
      reasoning: true,
      lifecycle: { sessionId: session.id, turnId: turn.id },
    });
    const profile = await db.executionProfiles.getByExecutionId(result.run.id);

    expect(profile).toMatchObject({
      schemaVersion: 1,
      executionId: result.run.id,
      workflowId: 'judge',
      workflowVersion: JUDGE_WORKFLOW_VERSION,
      graphFingerprint: judgeWorkflowGraphFingerprint(),
      command: 'judge', ticker: 'BBCA',
      payload: {
        reasoningMode: 'reasoning', conditional: true,
        researchers: config.researchers,
        provider: config.llm.agent.provider, model: config.llm.agent.model,
      },
    });
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(provider.mock.invocationCallOrder[0]!);
  });

  it('fails before provider work when lifecycle profile persistence fails', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const context = buildContext(db, config, { sessionId: 'resumability-test-session-2' });
    const session = await db.sessions.createSession({
      title: 'Profile failure', provider: config.llm.agent.provider, model: config.llm.agent.model, reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    vi.spyOn(db.executionProfiles, 'save').mockRejectedValue(new Error('profile storage unavailable'));
    const provider = vi.spyOn(context.financialData, 'getCompanyReport');

    await expect(judgeWorkflow(context, 'BBCA', () => {}, () => {}, {
      lifecycle: { sessionId: session.id, turnId: turn.id },
    })).rejects.toThrow('profile storage unavailable');
    expect(provider).not.toHaveBeenCalled();
    const artifacts = await db.sessions.getSessionArtifacts(session.id);
    expect(artifacts.executions[0]).toMatchObject({ status: 'failed' });
  });

  it('reconciles a running canonical execution as interrupted and leaves its turn resumable', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const session = await db.sessions.createSession({
      sessionId: 'conversation_resume', title: 'Resume', provider: config.llm.agent.provider, model: config.llm.agent.model, reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: '/judge BBCA', command: 'judge' });
    const execution = await db.sessions.createExecution({
      sessionId: session.id, turnId: turn.id, executionId: 'run-reconcile', ticker: 'BBCA', command: 'judge',
    });
    db.journal.append(session.id, { type: 'message.added', id: 'message-1', role: 'user', content: '/judge BBCA', state: 'completed' });
    db.journal.append(session.id, { type: 'turn.started', id: turn.id, turnId: turn.id, correlationId: turn.id });
    db.journal.append(session.id, { type: 'run.started', id: execution.id, subject: 'BBCA', command: 'judge', turnId: turn.id, executionId: execution.id, correlationId: turn.id });

    const controller = await ConversationController.create(db, config, () => {});
    const artifacts = await db.sessions.getSessionArtifacts(session.id);
    expect(artifacts.executions[0]).toMatchObject({
      id: execution.id, status: 'interrupted', completedAt: null, resumeGeneration: execution.resumeGeneration,
    });
    expect(artifacts.turns[0]).toMatchObject({ id: turn.id, status: 'running', completedAt: null });
    expect(controller.snapshot.blocks).toContainEqual(expect.objectContaining({ id: execution.id, kind: 'run', state: 'running' }));
    expect(db.journal.read(session.id).some(entry => entry.payload.type === 'run.settled' || entry.payload.type === 'turn.settled')).toBe(false);
  });
});
