import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-research-session-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('research session persistence', () => {
  it('persists an accepted turn without creating an execution', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-direct', title: 'Direct conversation', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });

    const turn = await db.sessions.createTurn({
      turnId: 'turn-direct', sessionId: session.id, input: 'jadi menurutmu bagaimana?', command: 'conversation',
    });

    const artifacts = await db.sessions.getSessionArtifacts(session.id);
    expect(turn).toMatchObject({ id: 'turn-direct', sessionId: session.id, status: 'running' });
    expect(artifacts.turns).toEqual([turn]);
    expect(artifacts.executions).toEqual([]);
  });

  it('assigns ordered execution attempts to one turn and settles them independently', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-retry', title: 'Retry lifecycle', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-retry', sessionId: session.id, input: '/judge BBRI', command: 'judge',
    });

    const first = await db.sessions.createExecution({
      executionId: 'run-retry-1', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });
    const failed = await db.sessions.settleExecution(first.id, 'failed', {
      error: 'API_TIMEOUT', completedAt: '2026-09-15T01:00:00.000Z',
    });
    const second = await db.sessions.createExecution({
      executionId: 'run-retry-2', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });
    const completed = await db.sessions.settleExecution(second.id, 'completed', {
      executionTimeSeconds: 12.3, completedAt: '2026-09-15T01:01:00.000Z',
    });

    expect(failed).toMatchObject({ turnId: turn.id, attempt: 1, status: 'failed', error: 'API_TIMEOUT' });
    expect(completed).toMatchObject({ turnId: turn.id, attempt: 2, status: 'completed', executionTime: 12.3 });
    expect((await db.sessions.getSessionArtifacts(session.id)).executions).toEqual([
      expect.objectContaining({ id: first.id, attempt: 1, status: 'failed' }),
      expect.objectContaining({ id: second.id, attempt: 2, status: 'completed' }),
    ]);
  });

  it('does not create another attempt after an execution completes successfully', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-success-terminal', title: 'Successful attempt', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-success-terminal', sessionId: session.id, input: '/judge BBRI', command: 'judge',
    });
    const execution = await db.sessions.createExecution({
      executionId: 'run-success-terminal', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });
    await db.sessions.settleExecution(execution.id, 'completed');

    await expect(db.sessions.createExecution({
      sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    })).rejects.toThrow('Turn turn-success-terminal already completed successfully');
  });

  it('preserves lifecycle linkage and attempt ordering across database restart', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-restart', title: 'Restart lifecycle', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-restart', sessionId: session.id, input: '/judge BBRI', command: 'judge',
    });
    const first = await db.sessions.createExecution({
      executionId: 'run-before-restart', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });
    await db.sessions.settleExecution(first.id, 'failed', { error: 'PROCESS_EXIT' });

    db.raw.close();
    db = openDb({ homeDir: dir });

    expect((await db.sessions.getSessionArtifacts(session.id)).executions).toEqual([
      expect.objectContaining({ id: first.id, sessionId: session.id, turnId: turn.id, attempt: 1, status: 'failed' }),
    ]);
    const second = await db.sessions.createExecution({
      executionId: 'run-after-restart', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });
    expect(second).toMatchObject({ sessionId: session.id, turnId: turn.id, attempt: 2, status: 'running' });
  });

  it('records cancellation as a terminal execution outcome', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-cancel', title: 'Cancellation', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-cancel', sessionId: session.id, input: '/judge BMRI', command: 'judge',
    });
    const execution = await db.sessions.createExecution({
      executionId: 'run-cancel', sessionId: session.id, turnId: turn.id, ticker: 'BMRI', command: 'judge',
    });

    const cancelled = await db.sessions.settleExecution(execution.id, 'cancelled', {
      error: 'Cancelled by user', completedAt: '2026-09-15T01:02:00.000Z',
    });

    expect(cancelled).toMatchObject({ status: 'cancelled', error: 'Cancelled by user' });
    await expect(db.sessions.settleExecution(execution.id, 'completed')).rejects.toThrow(/already cancelled/);
  });

  it('rejects linking an execution to a turn from another session', async () => {
    const firstSession = await db.sessions.createSession({
      sessionId: 'session-owner', title: 'Owner', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const otherSession = await db.sessions.createSession({
      sessionId: 'session-other', title: 'Other', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-owner', sessionId: firstSession.id, input: '/judge BBRI', command: 'judge',
    });

    await expect(db.sessions.createExecution({
      sessionId: otherSession.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    })).rejects.toThrow('Turn turn-owner does not belong to session session-other');
  });

  it('settles a turn exactly once under concurrent terminal requests', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-turn-race', title: 'Turn race', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-race', sessionId: session.id, input: 'hello', command: 'conversation',
    });

    const outcomes = await Promise.allSettled([
      db.sessions.settleTurn(turn.id, 'completed'),
      db.sessions.settleTurn(turn.id, 'stopped'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('settles an execution exactly once under concurrent terminal requests', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-execution-race', title: 'Execution race', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-execution-race', sessionId: session.id, input: '/judge BBRI', command: 'judge',
    });
    const execution = await db.sessions.createExecution({
      executionId: 'run-execution-race', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });

    const outcomes = await Promise.allSettled([
      db.sessions.settleExecution(execution.id, 'completed'),
      db.sessions.settleExecution(execution.id, 'cancelled'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('rejects overlapping attempts and settlement while an execution is running', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-order', title: 'Lifecycle ordering', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-order', sessionId: session.id, input: '/judge BBRI', command: 'judge',
    });
    await db.sessions.createExecution({
      executionId: 'run-order', sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    });

    await expect(db.sessions.createExecution({
      sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    })).rejects.toThrow('Turn turn-order already has a running execution');
    await expect(db.sessions.settleTurn(turn.id, 'completed')).rejects.toThrow(
      'Turn turn-order cannot settle while execution run-order is running',
    );
  });

  it('rejects new attempts after the turn has settled', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-terminal-turn', title: 'Terminal turn', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-terminal', sessionId: session.id, input: 'hello', command: 'conversation',
    });
    await db.sessions.settleTurn(turn.id, 'completed');

    await expect(db.sessions.createExecution({
      sessionId: session.id, turnId: turn.id, ticker: 'BBRI', command: 'judge',
    })).rejects.toThrow('Turn turn-terminal is already completed');
  });

  it('does not reparent an execution through the transitional runId field', async () => {
    const firstSession = await db.sessions.createSession({
      sessionId: 'session-first-link', title: 'First', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const secondSession = await db.sessions.createSession({
      sessionId: 'session-second-link', title: 'Second', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const run = await db.execution.createRun({ ticker: 'BBRI', command: 'judge', runId: 'run-one-owner' });
    await db.sessions.createTurn({
      turnId: 'turn-first-link', sessionId: firstSession.id, runId: run.id, input: '/judge BBRI', command: 'judge',
    });

    await expect(db.sessions.createTurn({
      turnId: 'turn-second-link', sessionId: secondSession.id, runId: run.id, input: '/judge BBRI', command: 'judge',
    })).rejects.toThrow('Execution run-one-owner already belongs to turn turn-first-link');
    expect((await db.sessions.getSessionArtifacts(firstSession.id)).executions).toEqual([
      expect.objectContaining({ id: run.id, turnId: 'turn-first-link' }),
    ]);
    expect((await db.sessions.getSessionArtifacts(secondSession.id)).turns).toEqual([]);
  });

  it('updates one durable workflow step across started and completed events', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-upsert', title: 'Trace lifecycle', provider: 'openai', model: 'gpt-test', reasoningMode: 'usual',
    });
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge', runId: 'run-upsert' });
    await db.sessions.createTurn({ sessionId: session.id, runId: run.id, input: '/judge BBCA', command: 'judge' });
    await db.sessions.saveStep({
      stepId: 'step-research', runId: run.id, nodeId: 'collect-sources', parentNodeIds: [], subagent: 'researcher', skills: [], status: 'running',
    });
    await db.sessions.saveStep({
      stepId: 'step-research', runId: run.id, nodeId: 'collect-sources', parentNodeIds: [], subagent: 'researcher',
      skills: [{ name: 'source-research', contentHash: 'hash-v1' }], status: 'completed', durationMs: 45, summary: 'Sources collected.',
    });

    const artifacts = await db.sessions.getSessionArtifacts(session.id);
    expect(artifacts.steps).toEqual([expect.objectContaining({
      id: 'step-research', status: 'completed', durationMs: 45, summary: 'Sources collected.',
      skills: [{ name: 'source-research', contentHash: 'hash-v1' }],
    })]);
  });

  it('retrieves a session with its turn, trace, skill hashes, and model usage', async () => {
    const session = await db.sessions.createSession({
      sessionId: 'session-1',
      title: 'Is BBCA fairly valued?',
      provider: 'openai',
      model: 'gpt-test',
      reasoningMode: 'reasoning',
    });
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge', runId: 'run-session-1' });
    const turn = await db.sessions.createTurn({
      turnId: 'turn-1',
      sessionId: session.id,
      runId: run.id,
      input: '/judge BBCA',
      command: 'judge',
    });
    await db.sessions.saveStep({
      stepId: 'step-valuation',
      runId: run.id,
      nodeId: 'evaluate-valuation',
      parentNodeIds: ['fetch-valuation'],
      subagent: 'valuation',
      skills: [{ name: 'relative-valuation', contentHash: 'hash-valuation-v1' }],
      status: 'completed',
      durationMs: 1250,
      summary: 'Premium verified against peers.',
    });
    await db.sessions.recordModelCall({
      callId: 'call-1',
      runId: run.id,
      stepId: 'step-valuation',
      subagent: 'valuation',
      provider: 'openai',
      model: 'gpt-test',
      attempt: 1,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 20,
      totalTokens: 140,
      latencyMs: 900,
      finishReason: 'stop',
      cost: 0.002,
      currency: 'USD',
    });
    await db.execution.failRun(run.id, 'Stopped by user');
    await db.sessions.settleTurn(turn.id, 'stopped', '2026-09-08T02:00:00.000Z');

    const artifacts = await db.sessions.getSessionArtifacts(session.id);

    expect(artifacts.session).toMatchObject({ id: 'session-1', model: 'gpt-test', reasoningMode: 'reasoning' });
    expect(artifacts.turns).toEqual([expect.objectContaining({ id: 'turn-1', runId: run.id, status: 'stopped' })]);
    expect(artifacts.steps).toEqual([expect.objectContaining({
      nodeId: 'evaluate-valuation',
      parentNodeIds: ['fetch-valuation'],
      skills: [{ name: 'relative-valuation', contentHash: 'hash-valuation-v1' }],
      durationMs: 1250,
    })]);
    expect(artifacts.modelCalls).toEqual([expect.objectContaining({
      stepId: 'step-valuation',
      inputTokens: 100,
      cachedInputTokens: 20,
      cost: 0.002,
    })]);
  });
});
