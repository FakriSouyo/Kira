import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

const PRE_Q2_MIGRATIONS = [
  '0001_initial.sql', '0002_normalized.sql', '0003_run_evidence.sql', '0004_evidence_hash_scoped.sql',
  '0005_research_sessions.sql', '0006_conversation_journal.sql', '0007_canonical_lifecycle.sql',
  '0008_session_working_context.sql', '0009_artifacts.sql', '0010_context_snapshots.sql',
  '0011_turn_model_calls.sql', '0012_financial_snapshots.sql', '0013_durable_resumability.sql',
];

describe('Q2 model selection migration', () => {
  let db: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    if (db?.raw.open) db.raw.close();
    db = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('backfills legacy session intent and adds nullable actual runtime columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-q2-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");
    for (const filename of PRE_Q2_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${filename}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(`./${filename}`);
    }
    legacy.prepare(`INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('legacy-q2-session', 'Legacy Q2', 'openrouter', 'qwen/qwen3', 'usual', '2026-09-20T00:00:00.000Z', '2026-09-20T00:00:00.000Z');
    legacy.close();

    db = openDb({ homeDir: dir });

    expect(await db.sessions.getCurrentModelSelection('legacy-q2-session')).toEqual({
      sessionId: 'legacy-q2-session', version: 1, providerId: 'openrouter', modelId: 'qwen/qwen3', source: 'legacy', selectedAt: '2026-09-20T00:00:00.000Z',
    });
    const columns = (db.raw.pragma('table_info(model_calls)') as Array<{ name: string }>).map(column => column.name);
    expect(columns).toEqual(expect.arrayContaining(['provider_id', 'model_id', 'adapter_id', 'protocol', 'runtime_fingerprint']));
  }, 15_000);

  it('preserves representative pre-Q2 lifecycle and audit rows without rewriting history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-q2-migration-preserve-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))) ");
    for (const filename of PRE_Q2_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${filename}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(`./${filename}`);
    }

    const sessionId = 'preserve-q2-session';
    const turnId = 'preserve-q2-turn';
    const executionId = 'preserve-q2-execution';
    const snapshotId = 'preserve-q2-context';
    const stepId = `step_${executionId}_round-1-bull-thesis`;
    const createdAt = '2026-09-19T12:00:00.000Z';
    const completedAt = '2026-09-19T12:05:00.000Z';
    const fingerprint = 'a'.repeat(64);
    const outputFingerprint = 'b'.repeat(64);
    const packetFingerprint = 'c'.repeat(64);

    legacy.prepare(`INSERT INTO research_sessions
      (id, title, provider, model, reasoning_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, 'Preserved session', 'legacy-provider', 'legacy-model', 'usual', createdAt, completedAt);
    legacy.prepare(`INSERT INTO research_turns
      (id, session_id, run_id, input, command, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(turnId, sessionId, executionId, 'Analyze ACME', 'judge', 'completed', createdAt, completedAt);
    legacy.prepare(`INSERT INTO executions
      (id, session_id, turn_id, attempt, ticker, command, status, execution_time, error, created_at, completed_at, resume_generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(executionId, sessionId, turnId, 1, 'ACME', 'judge', 'completed', 42.5, null, createdAt, completedAt, 0);
    legacy.prepare(`INSERT INTO workflow_steps
      (id, run_id, node_id, parent_node_ids, subagent, skills, status, duration_ms, summary, error, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(stepId, executionId, 'round-1-bull-thesis', '[]', 'bull', '[]', 'completed', 1200, 'historic step', null, createdAt, completedAt);
    legacy.prepare(`INSERT INTO context_snapshots
      (snapshot_id, session_id, turn_id, working_context_version, schema_version, packet_fingerprint, packet_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(snapshotId, sessionId, turnId, 3, 1, packetFingerprint, JSON.stringify({ sessionId, turnId, version: 3 }), createdAt);
    legacy.prepare(`INSERT INTO model_calls
      (id, run_id, turn_id, step_id, context_snapshot_id, subagent, provider, model, attempt,
       input_tokens, output_tokens, cached_input_tokens, total_tokens, latency_ms, finish_reason,
       cost, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('preserve-q2-call', executionId, null, stepId, snapshotId, 'bull', 'legacy-provider', 'legacy-model', 1,
        100, 25, 10, 125, 450, 'stop', 0.12, 'USD', createdAt);
    legacy.prepare(`INSERT INTO execution_profiles
      (execution_id, schema_version, workflow_id, workflow_version, graph_fingerprint, command, ticker, payload_json, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(executionId, 1, 'judge', 1, fingerprint, 'judge', 'ACME', JSON.stringify({ provider: 'legacy-provider', model: 'legacy-model' }), fingerprint, createdAt);
    legacy.prepare(`INSERT INTO workflow_node_outputs
      (output_id, schema_version, execution_id, workflow_id, workflow_version, node_id, status, output_kind,
       dependency_fingerprint, output_fingerprint, payload_json, completion_generation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('preserve-q2-output', 1, executionId, 'judge', 1, 'round-1-bull-thesis', 'completed', 'checkpoint',
        fingerprint, outputFingerprint, JSON.stringify({ historic: true }), 0, completedAt);
    legacy.prepare(`INSERT INTO artifacts
      (artifact_id, kind, schema_version, session_id, turn_id, execution_id, ticker, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('preserve-q2-artifact', 'BULL_CASE', 1, sessionId, turnId, executionId, 'ACME', JSON.stringify({ historic: true }), completedAt);
    legacy.prepare(`INSERT INTO financial_snapshots
      (snapshot_id, schema_version, session_id, turn_id, execution_id, ticker, payload_json, fingerprint, created_at, finalized_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('preserve-q2-financial', 1, sessionId, turnId, executionId, 'ACME', JSON.stringify({ revenue: 100 }), outputFingerprint, createdAt, completedAt);
    legacy.close();

    db = openDb({ homeDir: dir });

    expect(db.raw.prepare('SELECT * FROM research_sessions WHERE id = ?').get(sessionId)).toEqual({
      id: sessionId, title: 'Preserved session', provider: 'legacy-provider', model: 'legacy-model',
      reasoning_mode: 'usual', created_at: createdAt, updated_at: completedAt,
    });
    expect(db.raw.prepare('SELECT * FROM research_turns WHERE id = ?').get(turnId)).toMatchObject({
      id: turnId, session_id: sessionId, run_id: executionId, input: 'Analyze ACME', command: 'judge',
      status: 'completed', started_at: createdAt, completed_at: completedAt,
    });
    expect(db.raw.prepare('SELECT ticker, status, created_at, completed_at, resume_generation FROM executions WHERE id = ?').get(executionId))
      .toEqual({ ticker: 'ACME', status: 'completed', created_at: createdAt, completed_at: completedAt, resume_generation: 0 });
    expect(db.raw.prepare('SELECT packet_fingerprint, packet_json FROM context_snapshots WHERE snapshot_id = ?').get(snapshotId))
      .toEqual({ packet_fingerprint: packetFingerprint, packet_json: JSON.stringify({ sessionId, turnId, version: 3 }) });
    expect(db.raw.prepare('SELECT provider, model, attempt, total_tokens, finish_reason, provider_id, model_id, adapter_id, protocol, runtime_fingerprint FROM model_calls WHERE id = ?').get('preserve-q2-call'))
      .toEqual({ provider: 'legacy-provider', model: 'legacy-model', attempt: 1, total_tokens: 125, finish_reason: 'stop', provider_id: null, model_id: null, adapter_id: null, protocol: null, runtime_fingerprint: null });
    expect(db.raw.prepare('SELECT workflow_id, workflow_version, graph_fingerprint, payload_json, fingerprint FROM execution_profiles WHERE execution_id = ?').get(executionId))
      .toEqual({ workflow_id: 'judge', workflow_version: 1, graph_fingerprint: fingerprint, payload_json: JSON.stringify({ provider: 'legacy-provider', model: 'legacy-model' }), fingerprint });
    expect(db.raw.prepare('SELECT node_id, dependency_fingerprint, output_fingerprint, payload_json, completion_generation FROM workflow_node_outputs WHERE output_id = ?').get('preserve-q2-output'))
      .toEqual({ node_id: 'round-1-bull-thesis', dependency_fingerprint: fingerprint, output_fingerprint: outputFingerprint, payload_json: JSON.stringify({ historic: true }), completion_generation: 0 });
    expect(db.raw.prepare('SELECT kind, payload_json, created_at FROM artifacts WHERE artifact_id = ?').get('preserve-q2-artifact'))
      .toEqual({ kind: 'BULL_CASE', payload_json: JSON.stringify({ historic: true }), created_at: completedAt });
    expect(db.raw.prepare('SELECT ticker, payload_json, fingerprint, finalized_at FROM financial_snapshots WHERE snapshot_id = ?').get('preserve-q2-financial'))
      .toEqual({ ticker: 'ACME', payload_json: JSON.stringify({ revenue: 100 }), fingerprint: outputFingerprint, finalized_at: completedAt });
    expect(await db.sessions.getCurrentModelSelection(sessionId)).toEqual({
      sessionId, version: 1, providerId: 'legacy-provider', modelId: 'legacy-model', source: 'legacy', selectedAt: createdAt,
    });
  }, 15_000);
});
