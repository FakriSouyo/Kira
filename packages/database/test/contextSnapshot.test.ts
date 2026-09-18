import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContextSnapshot, type ContextPacket } from '@harness/context';
import { openDb, type FinharnessDatabase } from '@harness/database';

const PACKET: ContextPacket = {
  schemaVersion: 1, sessionId: 'session-snapshot', turnId: 'turn-snapshot',
  activeSubjects: [{ ticker: 'BBRI' }], intent: { command: 'conversation' }, focusTopics: [], artifacts: [],
  userAssertions: [{ kind: 'USER_ASSERTION', id: 'assert-1', text: 'NIM turun', turnId: 'turn-snapshot' }],
  assumptions: [], unresolvedQuestions: [],
  provenance: {
    sessionId: 'session-snapshot', turnId: 'turn-snapshot', workingContextVersion: 7, sourceContextSequence: 21,
    sourceRefs: [], selectedArtifactIds: [], diagnostics: [],
  },
};

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-context-snapshot-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

async function lifecycle(sessionId = 'session-snapshot', turnId = 'turn-snapshot') {
  const session = await db.sessions.createSession({ sessionId, title: 'Snapshot test', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
  const turn = await db.sessions.createTurn({ sessionId, turnId, input: 'jadi menurutmu bagaimana?', command: 'conversation' });
  return { session, turn };
}

function makeSnapshot(sessionId = 'session-snapshot', turnId = 'turn-snapshot', createdAt = '2026-09-18T00:00:00.000Z') {
  const packet = sessionId === PACKET.sessionId && turnId === PACKET.turnId
    ? PACKET
    : { ...PACKET, sessionId, turnId, provenance: { ...PACKET.provenance, sessionId, turnId } } as ContextPacket;
  return createContextSnapshot({ sessionId, turnId, packet, createdAt });
}

describe('ContextSnapshotStoreSqlite', () => {
  it('persists a valid snapshot and reads the exact structured packet', async () => {
    await lifecycle();
    const saved = await db.contextSnapshots.save(makeSnapshot());
    expect(saved).toEqual(makeSnapshot());
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.packet)).toBe(true);
    expect(await db.contextSnapshots.getById(saved.snapshotId)).toEqual(saved);
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as { count: number }).count).toBe(1);
  });

  it('is restart-safe and preserves provenance, assertions, and subjects', async () => {
    await lifecycle();
    const saved = await db.contextSnapshots.save(makeSnapshot());
    db.raw.close();
    db = openDb({ homeDir: dir });
    const loaded = await db.contextSnapshots.getById(saved.snapshotId);
    expect(loaded).toEqual(saved);
    expect(loaded?.packet.provenance).toMatchObject({ workingContextVersion: 7, sourceContextSequence: 21 });
    expect(loaded?.packet.userAssertions[0]?.kind).toBe('USER_ASSERTION');
    expect(loaded?.packet.activeSubjects).toEqual([{ ticker: 'BBRI' }]);
  });

  it('returns the existing immutable row for an identical retry', async () => {
    await lifecycle();
    const first = await db.contextSnapshots.save(makeSnapshot(undefined, undefined, '2026-09-18T00:00:00.000Z'));
    const retry = await db.contextSnapshots.save(makeSnapshot(undefined, undefined, '2026-09-18T01:00:00.000Z'));
    expect(retry).toEqual(first);
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as { count: number }).count).toBe(1);
  });

  it('rejects an immutable identity conflict instead of overwriting history', async () => {
    await lifecycle();
    const first = makeSnapshot();
    await db.contextSnapshots.save(first);
    const conflict = createContextSnapshot({
      sessionId: 'session-snapshot', turnId: 'turn-snapshot', packet: {
        ...PACKET, focusTopics: [{ topic: 'risk' }],
      }, snapshotId: first.snapshotId, createdAt: first.createdAt,
    });
    await expect(db.contextSnapshots.save(conflict)).rejects.toThrow(/immutable|conflict/i);
    expect((await db.contextSnapshots.getById(first.snapshotId))?.packet.focusTopics).toEqual([]);
  });

  it('rejects snapshots for unknown lifecycle rows', async () => {
    await expect(db.contextSnapshots.save(makeSnapshot('missing-session', 'missing-turn'))).rejects.toThrow(/session|foreign|constraint/i);
  });

  it('does not update working context, journal, artifacts, or provider state', async () => {
    await lifecycle();
    const beforeContext = db.raw.prepare('SELECT COUNT(*) AS count FROM session_context_versions').get();
    const beforeEvents = db.raw.prepare('SELECT COUNT(*) AS count FROM conversation_events').get();
    const beforeArtifacts = db.raw.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    await db.contextSnapshots.save(makeSnapshot());
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM session_context_versions').get()).toEqual(beforeContext);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM conversation_events').get()).toEqual(beforeEvents);
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM artifacts').get()).toEqual(beforeArtifacts);
  });
});

describe('ModelCall contextSnapshot linkage', () => {
  it('persists an optional snapshot reference and resolves it after restart', async () => {
    const { session, turn } = await lifecycle();
    const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: 'run-snapshot', ticker: 'BBRI', command: 'conversation' });
    await db.sessions.saveStep({ stepId: 'step-snapshot', runId: execution.id, nodeId: 'conversation', parentNodeIds: [], status: 'completed', skills: [] });
    const saved = await db.contextSnapshots.save(makeSnapshot());
    await db.sessions.recordModelCall({
      callId: 'call-snapshot', runId: execution.id, stepId: 'step-snapshot', subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalTokens: 15, latencyMs: 4, finishReason: 'stop', cost: 0.01, currency: 'USD',
      contextSnapshotId: saved.snapshotId,
    });
    expect((await db.sessions.getSessionArtifacts(session.id)).modelCalls[0]?.contextSnapshotId).toBe(saved.snapshotId);
    db.raw.close();
    db = openDb({ homeDir: dir });
    const artifacts = await db.sessions.getSessionArtifacts(session.id);
    expect(artifacts.modelCalls[0]?.contextSnapshotId).toBe(saved.snapshotId);
    expect(await db.contextSnapshots.getById(artifacts.modelCalls[0]!.contextSnapshotId!)).toEqual(saved);
  });

  it('keeps contextSnapshotId null for calls without a ContextPacket', async () => {
    const { session, turn } = await lifecycle();
    const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: 'run-null-context', ticker: 'BBRI', command: 'conversation' });
    await db.sessions.saveStep({ stepId: 'step-null-context', runId: execution.id, nodeId: 'conversation', parentNodeIds: [], status: 'completed', skills: [] });
    await db.sessions.recordModelCall({
      callId: 'call-null-context', runId: execution.id, stepId: 'step-null-context', subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, latencyMs: 1, finishReason: null, cost: null, currency: null,
    });
    expect((await db.sessions.getSessionArtifacts(session.id)).modelCalls[0]?.contextSnapshotId).toBeNull();
  });

  it('rejects a missing snapshot and never silently drops explicit linkage', async () => {
    const { session, turn } = await lifecycle();
    const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: 'run-missing-context', ticker: 'BBRI', command: 'conversation' });
    await db.sessions.saveStep({ stepId: 'step-missing-context', runId: execution.id, nodeId: 'conversation', parentNodeIds: [], status: 'completed', skills: [] });
    await expect(db.sessions.recordModelCall({
      callId: 'call-missing-context', runId: execution.id, stepId: 'step-missing-context', subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, latencyMs: 1, finishReason: null, cost: null, currency: null,
      contextSnapshotId: 'snapshot_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })).rejects.toThrow(/snapshot/i);
  });

  it('rejects a snapshot from another session/turn', async () => {
    const first = await lifecycle();
    const second = await lifecycle('session-other', 'turn-other');
    const execution = await db.sessions.createExecution({ sessionId: first.session.id, turnId: first.turn.id, executionId: 'run-cross-context', ticker: 'BBRI', command: 'conversation' });
    await db.sessions.saveStep({ stepId: 'step-cross-context', runId: execution.id, nodeId: 'conversation', parentNodeIds: [], status: 'completed', skills: [] });
    const otherPacket = { ...PACKET, sessionId: second.session.id, turnId: second.turn.id, provenance: { ...PACKET.provenance, sessionId: second.session.id, turnId: second.turn.id } } as ContextPacket;
    const saved = await db.contextSnapshots.save(createContextSnapshot({ sessionId: second.session.id, turnId: second.turn.id, packet: otherPacket }));
    await expect(db.sessions.recordModelCall({
      callId: 'call-cross-context', runId: execution.id, stepId: 'step-cross-context', subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null, latencyMs: 1, finishReason: null, cost: null, currency: null,
      contextSnapshotId: saved.snapshotId,
    })).rejects.toThrow(/session|turn/i);
  });

  it('allows multiple model calls to reference one immutable snapshot', async () => {
    const { session, turn } = await lifecycle();
    const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: 'run-multi-call', ticker: 'BBRI', command: 'conversation' });
    await db.sessions.saveStep({ stepId: 'step-multi-call', runId: execution.id, nodeId: 'conversation', parentNodeIds: [], status: 'completed', skills: [] });
    const saved = await db.contextSnapshots.save(makeSnapshot());
    const common = {
      runId: execution.id, stepId: 'step-multi-call', subagent: 'conversation', provider: 'openai', model: 'mock', attempt: 1,
      inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2, latencyMs: 1, finishReason: 'stop', cost: 0, currency: 'USD' as const,
      contextSnapshotId: saved.snapshotId,
    };
    await db.sessions.recordModelCall({ ...common, callId: 'call-one' });
    await db.sessions.recordModelCall({ ...common, callId: 'call-two' });
    expect((await db.sessions.getSessionArtifacts(session.id)).modelCalls.map(call => call.contextSnapshotId)).toEqual([saved.snapshotId, saved.snapshotId]);
  });
});

describe('PR H migration', () => {
  it('adds snapshot persistence and nullable ModelCall linkage to a PR G database', async () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'finharness-context-migration-'));
    const legacy = new Database(join(legacyDir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
    const prior = [
      './0001_initial.sql', './0002_normalized.sql', './0003_run_evidence.sql', './0004_evidence_hash_scoped.sql',
      './0005_research_sessions.sql', './0006_conversation_journal.sql', './0007_canonical_lifecycle.sql',
      './0008_session_working_context.sql', './0009_artifacts.sql',
    ];
    for (const name of prior) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${name.slice(2)}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    legacy.exec("INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES ('legacy-session', 'Legacy', 'openai', 'mock', 'usual', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z');");
    legacy.exec("INSERT INTO research_turns (id, session_id, input, command, status, started_at) VALUES ('legacy-turn', 'legacy-session', 'hello', 'conversation', 'completed', '2026-09-18T00:00:00.000Z');");
    legacy.exec("INSERT INTO executions (id, session_id, turn_id, attempt, ticker, command, status, created_at) VALUES ('legacy-run', 'legacy-session', 'legacy-turn', 1, 'BBRI', 'conversation', 'completed', '2026-09-18T00:00:00.000Z');");
    legacy.exec("INSERT INTO workflow_steps (id, run_id, node_id, parent_node_ids, skills, status, created_at) VALUES ('legacy-step', 'legacy-run', 'conversation', '[]', '[]', 'completed', '2026-09-18T00:00:00.000Z');");
    legacy.exec("INSERT INTO model_calls (id, run_id, step_id, subagent, provider, model, attempt, latency_ms, created_at) VALUES ('legacy-call', 'legacy-run', 'legacy-step', 'conversation', 'openai', 'mock', 1, 1, '2026-09-18T00:00:00.000Z');");
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    const migrated = openDb({ homeDir: legacyDir });
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_snapshots'").get()).toEqual({ name: 'context_snapshots' });
    expect(migrated.raw.prepare('SELECT context_snapshot_id FROM model_calls WHERE id = ?').get('legacy-call')).toEqual({ context_snapshot_id: null });
    expect(migrated.raw.prepare('SELECT name FROM _migrations WHERE name = ?').get('./0010_context_snapshots.sql')).toEqual({ name: './0010_context_snapshots.sql' });
    expect((await migrated.sessions.getSessionArtifacts('legacy-session')).modelCalls[0]?.contextSnapshotId).toBeNull();
    migrated.raw.close();
    rmSync(legacyDir, { recursive: true, force: true });
  }, 15_000);
});
