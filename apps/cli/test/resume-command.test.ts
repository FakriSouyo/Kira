import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExecutionProfile } from '@harness/session-core';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { createHarnessSession } from '../src/repl/session';

describe('/resume control-command lifecycle', () => {
  let homeDir: string;
  let db: FinharnessDatabase;
  let session: Awaited<ReturnType<typeof createHarnessSession>>;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-resume-command-'));
    db = openDb({ homeDir });
    const config = loadConfig({ homeDir, mockSectors: true, mockLlm: true });
    const conversation = await db.sessions.createSession({
      sessionId: 'conversation_resume_control',
      title: 'Resume control',
      provider: config.llm.agent.provider,
      model: config.llm.agent.model,
      reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({
      turnId: 'turn_original_judge',
      sessionId: conversation.id,
      input: '/judge BBCA',
      command: 'judge',
    });
    const execution = await db.sessions.createExecution({
      executionId: 'run_original_judge',
      sessionId: conversation.id,
      turnId: turn.id,
      ticker: 'BBCA',
      command: 'judge',
    });
    await db.executionProfiles.save(createExecutionProfile({
      executionId: execution.id,
      workflowId: 'judge',
      workflowVersion: 1,
      graphFingerprint: 'a'.repeat(64),
      command: 'judge',
      ticker: 'BBCA',
      payload: {
        reasoningMode: 'usual',
        conditional: false,
        researchers: { market: true, news: true },
        provider: config.llm.agent.provider,
        model: config.llm.agent.model,
      },
      createdAt: execution.createdAt,
    }));
    await db.sessions.interruptExecution(execution.id, 'process exited unexpectedly');
    db.journal.append(conversation.id, {
      type: 'message.added', id: 'message_original_judge', role: 'user', content: '/judge BBCA', state: 'completed',
      turnId: turn.id, executionId: execution.id, correlationId: turn.id,
    });
    db.journal.append(conversation.id, {
      type: 'turn.started', id: turn.id, turnId: turn.id, correlationId: turn.id,
    });
    db.journal.append(conversation.id, {
      type: 'run.started', id: execution.id, subject: 'BBCA', command: 'judge',
      turnId: turn.id, executionId: execution.id, correlationId: turn.id,
    });

    // Keep the real session wrapper in the test: it is the component that must
    // distinguish a control command from ordinary new-turn commands.
    session = await createHarnessSession(db, config, { write: () => {} });
  });

  afterEach(async () => {
    await session.close();
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('rejects an incompatible checkpoint without creating a control Turn', async () => {
    const resume = session.commands.get('resume');
    expect(resume).toBeDefined();

    await expect(resume!(['run_original_judge'], { input: '/resume run_original_judge' }))
      .rejects.toThrow(/predates true Judge checkpoint support/i);

    const artifacts = await db.sessions.getSessionArtifacts('conversation_resume_control');
    expect(artifacts.turns).toHaveLength(1);
    expect(artifacts.turns[0]).toMatchObject({ id: 'turn_original_judge', status: 'running' });
    expect(artifacts.executions).toHaveLength(1);
    expect(artifacts.executions[0]).toMatchObject({ id: 'run_original_judge', status: 'interrupted', resumeGeneration: 0 });

    const lifecycleEvents = db.journal.read('conversation_resume_control').filter((entry) =>
      entry.payload.type === 'turn.started' || entry.payload.type === 'run.started');
    expect(lifecycleEvents.map((entry) => entry.payload.type)).toEqual(['turn.started', 'run.started']);
  });
});
