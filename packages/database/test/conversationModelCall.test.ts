import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextSnapshot, type ContextPacket } from '@harness/context';
import { openDb, type FinharnessDatabase } from '@harness/database';

const packet = (sessionId: string, turnId: string): ContextPacket => ({
  schemaVersion: 1,
  sessionId,
  turnId,
  activeSubjects: [{ ticker: 'BBRI' }],
  intent: { command: 'conversation' },
  focusTopics: [],
  artifacts: [],
  userAssertions: [],
  assumptions: [],
  unresolvedQuestions: [],
  provenance: {
    sessionId,
    turnId,
    workingContextVersion: 1,
    sourceContextSequence: 2,
    sourceRefs: [],
    selectedArtifactIds: [],
    diagnostics: [],
  },
});

describe('turn-owned conversational ModelCalls', () => {
  let db: FinharnessDatabase;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-conversation-model-call-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a context-linked call without fabricating a ResearchExecution', async () => {
    const session = await db.sessions.createSession({ sessionId: 'session-model-call', title: 'Conversation', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ sessionId: session.id, turnId: 'turn-model-call', input: 'jadi menurutmu bagaimana?', command: 'conversation' });
    const snapshot = await db.contextSnapshots.save(createContextSnapshot({ sessionId: session.id, turnId: turn.id, packet: packet(session.id, turn.id) }));

    const call = await db.sessions.recordModelCall({
      turnId: turn.id, subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
      latencyMs: 4, finishReason: 'stop', cost: null, currency: null,
      contextSnapshotId: snapshot.snapshotId,
    });

    expect(call).toMatchObject({ runId: null, stepId: null, turnId: turn.id, contextSnapshotId: snapshot.snapshotId });
    expect((await db.sessions.getSessionArtifacts(session.id)).executions).toEqual([]);
    expect((await db.sessions.getSessionArtifacts(session.id)).modelCalls).toEqual([call]);
  });

  it('keeps a context-free conversational call explicitly unlinked', async () => {
    const session = await db.sessions.createSession({ sessionId: 'session-null-call', title: 'Conversation', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const turn = await db.sessions.createTurn({ sessionId: session.id, turnId: 'turn-null-call', input: 'halo', command: 'conversation' });

    const call = await db.sessions.recordModelCall({
      turnId: turn.id, subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null,
      latencyMs: 2, finishReason: 'stop', cost: null, currency: null,
    });

    expect(call).toMatchObject({ runId: null, stepId: null, turnId: turn.id, contextSnapshotId: null });
  });
});
