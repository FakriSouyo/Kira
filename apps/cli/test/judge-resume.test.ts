import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowRunner } from '@harness/command-core';
import {
  createJudgeCommandContext,
  createJudgeExecutionProfile,
  createJudgeWorkflow,
} from '@harness/command-judge';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { createWorkflowNodeOutput } from '@harness/session-core';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';
import { createJudgeNodeExecutors } from '../src/workflows/judgeNodes';
import { decodeJudgeCheckpoint, JudgeCheckpointWriter } from '../src/workflows/judgeCheckpoint';

describe('PR P same-Execution Judge resume', () => {
  let homeDir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-judge-resume-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('continues a checkpointed prefix in the same Execution without refetching completed sources', async () => {
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const context = buildContext(db, config, { sessionId: 'judge-resume-test-session' });
    const session = await db.sessions.createSession({
      sessionId: 'conversation_same_execution',
      title: 'Same execution resume',
      provider: config.llm.agent.provider,
      model: config.llm.agent.model,
      reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn_same_execution',
      sessionId: session.id,
      input: '/judge BBCA',
      command: 'judge',
    });
    const execution = await db.sessions.createExecution({
      executionId: 'run_same_execution',
      sessionId: session.id,
      turnId: turn.id,
      ticker: 'BBCA',
      command: 'judge',
    });
    const definition = createJudgeWorkflow();
    const profile = createJudgeExecutionProfile({
      executionId: execution.id,
      ticker: 'BBCA',
      reasoningMode: 'usual',
      conditional: false,
      researchers: config.researchers,
      provider: config.llm.agent.provider,
      model: config.llm.agent.model,
      capabilityPlan: context.judgeCapabilityPlan,
      createdAt: execution.createdAt,
    });
    await db.executionProfiles.save(profile);

    const decision = {};
    const prefix = { ...definition, nodes: definition.nodes.slice(0, 7) };
    const writer = new JudgeCheckpointWriter({ db, execution, profile, definition });
    const executors = createJudgeNodeExecutors({
      ctx: context,
      ticker: 'BBCA',
      runId: execution.id,
      events: () => {},
      progress: () => {},
      decision,
      reasoning: false,
      conditional: false,
      researchers: config.researchers,
      executionStartedAt: execution.createdAt,
      lifecycle: { sessionId: session.id, turnId: turn.id },
    });
    await new WorkflowRunner({
      onNodeCompleted: (node, value, inputs) => writer.completed(node, value, inputs),
      onNodeSkipped: node => writer.skipped(node),
      onNodeFailed: (node, error) => writer.optionalFailure(node, error),
    }).run(prefix, createJudgeCommandContext({
      reasoningMode: 'usual',
      conditional: false,
      researchers: config.researchers,
      executors,
      decision,
    }));
    await db.sessions.interruptExecution(execution.id, 'test interruption after durable prefix');

    const checkpointed = await db.workflowNodeOutputs.listNodeOutputsForExecution(execution.id);
    expect(checkpointed.map(output => output.nodeId)).toEqual(prefix.nodes.map(node => node.id));

    db.journal.append(session.id, {
      type: 'message.added', id: 'message_same_execution', role: 'user', content: '/judge BBCA', state: 'completed',
      turnId: turn.id, executionId: execution.id, correlationId: turn.id,
    });
    db.journal.append(session.id, {
      type: 'turn.started', id: turn.id, turnId: turn.id, correlationId: turn.id,
    });
    db.journal.append(session.id, {
      type: 'run.started', id: execution.id, subject: 'BBCA', command: 'judge',
      turnId: turn.id, executionId: execution.id, correlationId: turn.id,
    });

    db.raw.close();
    db = openDb({ homeDir });
    const events: Array<{ type: string; runId?: string; status?: string }> = [];
    const runtime = await createHarnessSession(db, config, {
      write: () => {},
      events: event => events.push(event),
    });
    const providerCalls = [
      'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
      'getForeignFlow', 'getNews', 'getFilings', 'getSentiment',
    ].map(method => vi.spyOn(runtime.context.financialData, method));
    await runtime.commands.get('continue')!([], { input: '/continue' });
    await runtime.close();

    expect(providerCalls.every(call => call.mock.calls.length === 0)).toBe(true);
    expect(events.some(event => event.type === 'session.start')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'session.complete', runId: execution.id, status: 'completed' }));

    const artifacts = await db.sessions.getSessionArtifacts(session.id);
    expect(artifacts.turns).toHaveLength(1);
    expect(artifacts.turns[0]).toMatchObject({ id: turn.id, status: 'completed' });
    expect(artifacts.executions).toHaveLength(1);
    expect(artifacts.executions[0]).toMatchObject({
      id: execution.id,
      turnId: turn.id,
      attempt: 1,
      status: 'completed',
      resumeGeneration: 1,
    });
  });

  it('rejects a malformed typed model payload before it can become a restore seed', async () => {
    const output = createWorkflowNodeOutput({
      executionId: 'run_corrupt_checkpoint', workflowId: 'judge', workflowVersion: 2,
      nodeId: 'round-1-bull-thesis', status: 'completed', outputKind: 'judge.bull-thesis.v1',
      dependencyFingerprint: 'a'.repeat(64),
      payload: {
        response: { reasoning: '', claims: [], evidenceIds: [] },
        claims: [], audit: { subagent: 'bull', skills: [] },
      } as never,
      completionGeneration: 0, createdAt: new Date().toISOString(),
    });

    await expect(decodeJudgeCheckpoint(
      'round-1-bull-thesis', output, undefined as never, { id: output.executionId, ticker: 'BBCA' } as never,
    )).rejects.toThrow();
  });
});
