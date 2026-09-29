import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { ArtifactEnvelope } from '@harness/schemas';

const PRIOR_MIGRATIONS = [
  './0001_initial.sql',
  './0002_normalized.sql',
  './0003_run_evidence.sql',
  './0004_evidence_hash_scoped.sql',
  './0005_research_sessions.sql',
  './0006_conversation_journal.sql',
  './0007_canonical_lifecycle.sql',
  './0008_session_working_context.sql',
] as const;

describe('PR F artifact migration', () => {
  let migrated: FinharnessDatabase | undefined;
  const dirs: string[] = [];

  afterEach(() => {
    if (migrated?.raw.open) migrated.raw.close();
    migrated = undefined;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('adds the artifact table forward-only while preserving prior lifecycle rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-artifact-migration-'));
    dirs.push(dir);
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
    for (const name of PRIOR_MIGRATIONS) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${name.slice(2)}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    legacy.prepare('INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('session_prior_f', 'Prior', 'openai', 'mock', 'usual', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z');
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    migrated = openDb({ homeDir: dir });
    expect(migrated.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'").get()).toEqual({ name: 'artifacts' });
    expect(migrated.raw.prepare('SELECT id FROM research_sessions WHERE id = ?').get('session_prior_f')).toEqual({ id: 'session_prior_f' });
    expect(migrated.raw.prepare('SELECT name FROM _migrations WHERE name = ?').get('./0009_artifacts.sql')).toEqual({ name: './0009_artifacts.sql' });
  }, 15_000);

  it('preserves Judge Artifacts and existing constraints while enabling Research Reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finharness-artifact-rebuild-'));
    dirs.push(dir);
    migrated = openDb({ homeDir: dir });
    const judgeSession = await migrated.sessions.createSession({ sessionId: 'session_judge_migration', title: 'Judge migration', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const judgeTurn = await migrated.sessions.createTurn({ sessionId: judgeSession.id, turnId: 'turn_judge_migration', input: '/judge BBCA', command: 'judge' });
    const judgeExecution = await migrated.sessions.createExecution({ sessionId: judgeSession.id, turnId: judgeTurn.id, executionId: 'run_judge_migration', ticker: 'BBCA', command: 'judge' });
    await migrated.sessions.settleExecution(judgeExecution.id, 'completed', { completedAt: '2026-09-20T00:00:00.000Z' });
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const argument = {
      messageId: 'migration-message', reasoning: 'The filing supports the company’s reported profitability.',
      claims: [{ claimId: 'migration-claim', statement: 'Profitability remained positive.', confidence: 'strong' as const, reasoning: 'The filing reports positive returns.', evidenceIds: [evidenceId] }],
      evidenceIds: [evidenceId],
    };
    const judgeArtifact: ArtifactEnvelope = {
      artifactId: 'artifact_bull_case_run_judge_migration', kind: 'BULL_CASE', schemaVersion: 1,
      sessionId: judgeSession.id, turnId: judgeTurn.id, executionId: judgeExecution.id, ticker: 'BBCA',
      payload: { thesis: argument, rebuttal: { ...argument, messageId: 'migration-rebuttal' } }, createdAt: '2026-09-20T00:01:00.000Z',
    };
    await migrated.artifacts.save(judgeArtifact);
    migrated.raw.close();
    migrated = undefined;

    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP INDEX artifacts_execution_idx;
      DROP INDEX artifacts_session_idx;
      ALTER TABLE artifacts RENAME TO artifacts_u1b_fixture;
      CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('BULL_CASE', 'BEAR_CASE', 'VERDICT')),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES research_turns(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        ticker TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        created_at TEXT NOT NULL,
        UNIQUE(execution_id, kind)
      );
      INSERT INTO artifacts SELECT * FROM artifacts_u1b_fixture;
      DROP TABLE artifacts_u1b_fixture;
      CREATE INDEX artifacts_execution_idx ON artifacts(execution_id, kind);
      CREATE INDEX artifacts_session_idx ON artifacts(session_id, created_at);
      DELETE FROM _migrations WHERE name = './0021_research_report_artifact.sql';
    `);
    legacy.close();

    migrated = openDb({ homeDir: dir });
    expect(await migrated.artifacts.getById(judgeArtifact.artifactId)).toEqual(judgeArtifact);
    expect(migrated.raw.prepare("SELECT name FROM _migrations WHERE name = './0021_research_report_artifact.sql'").get()).toEqual({ name: './0021_research_report_artifact.sql' });
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((migrated.raw.prepare('PRAGMA foreign_key_list(artifacts)').all() as Array<{ table: string }>).map(row => row.table).sort()).toEqual(['executions', 'research_sessions', 'research_turns']);
    const indexes = (migrated.raw.prepare('PRAGMA index_list(artifacts)').all() as Array<{ name: string }>).map(row => row.name);
    expect(indexes).toContain('artifacts_execution_idx');
    expect(indexes).toContain('artifacts_session_idx');
    expect(indexes.filter(name => name.startsWith('sqlite_autoindex_artifacts_'))).toHaveLength(2);

    const opened = migrated;
    const researchSession = await opened.sessions.createSession({ sessionId: 'session_research_migration', title: 'Research migration', provider: 'openai', model: 'mock', reasoningMode: 'usual' });
    const researchTurn = await opened.sessions.createTurn({ sessionId: researchSession.id, turnId: 'turn_research_migration', input: 'Research BBCA.', command: 'research' });
    const researchExecution = await opened.sessions.createExecution({ sessionId: researchSession.id, turnId: researchTurn.id, executionId: 'run_research_migration', ticker: 'BBCA', command: 'research' });
    const report = await opened.researchReportPublication.completeAndPublish({
      executionId: researchExecution.id,
      payload: { question: 'Assess BBCA.', summary: 'The available sources support the report.', findings: [], sourceAssessments: [], gaps: [], coverage: [] },
      executionTimeSeconds: 0,
    });
    expect(report.artifact.kind).toBe('RESEARCH_REPORT');
    expect(() => opened.raw.prepare(`INSERT INTO artifacts
      (artifact_id, kind, schema_version, session_id, turn_id, execution_id, ticker, payload_json, created_at)
      VALUES ('bad-version', 'RESEARCH_REPORT', 2, ?, ?, ?, 'BBCA', '{}', '2026-09-20T00:00:00.000Z')`)
      .run(researchSession.id, researchTurn.id, researchExecution.id)).toThrow();
    expect(() => opened.raw.prepare(`INSERT INTO artifacts
      (artifact_id, kind, schema_version, session_id, turn_id, execution_id, ticker, payload_json, created_at)
      VALUES ('duplicate-report', 'RESEARCH_REPORT', 1, ?, ?, ?, 'BBCA', '{}', '2026-09-20T00:00:00.000Z')`)
      .run(researchSession.id, researchTurn.id, researchExecution.id)).toThrow(/unique/i);
  }, 15_000);
});
