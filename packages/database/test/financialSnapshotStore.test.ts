import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNotRequestedObservation,
  createVerifiedFinancialSnapshot,
  verifyFinancialObservation,
  type FinancialObservation,
} from '@harness/financial-data';
import { openDb, type FinharnessDatabase } from '@harness/database';

const metadata = {
  providerId: 'sectors', source: 'sectors.company_report', origin: 'MOCK' as const,
  fetchedAt: null, dataAsOf: '2026-09-18T00:00:00.000Z', requestedAsOf: null, period: null, derivedFrom: [],
};

function observations(companyValue = 1): FinancialObservation[] {
  const report = verifyFinancialObservation('company_report', {
    data: { ticker: 'BBRI', financials: { roe: companyValue }, valuation: { pe: -1 } }, metadata,
  }, 'BBRI');
  const quarterly = verifyFinancialObservation('quarterly_financials', {
    data: { ticker: 'BBRI', quarters: [{ period: '2026-Q2', revenue: -10, netIncome: -2 }] },
    metadata: { ...metadata, source: 'sectors.quarterly_financials', dataAsOf: null, period: '2026-Q2' },
  }, 'BBRI');
  return [
    report,
    quarterly,
    createNotRequestedObservation('daily_transaction'),
    createNotRequestedObservation('foreign_flow'),
    createNotRequestedObservation('news'),
    createNotRequestedObservation('filings'),
    createNotRequestedObservation('sentiment'),
  ];
}

async function lifecycle(db: FinharnessDatabase, ids = { sessionId: 'session-fs', turnId: 'turn-fs', executionId: 'run-fs' }) {
  const session = await db.sessions.createSession({
    sessionId: ids.sessionId, title: 'Financial snapshot', provider: 'mock', model: 'mock', reasoningMode: 'usual',
  });
  const turn = await db.sessions.createTurn({ sessionId: session.id, turnId: ids.turnId, input: '/judge BBRI', command: 'judge' });
  const execution = await db.sessions.createExecution({ sessionId: session.id, turnId: turn.id, executionId: ids.executionId, ticker: 'BBRI', command: 'judge' });
  return execution;
}

function snapshot(execution: { sessionId: string; turnId: string; id: string; ticker: string }, companyValue = 1, finalizedAt = '2026-09-19T00:01:00.000Z') {
  return createVerifiedFinancialSnapshot({
    sessionId: execution.sessionId,
    turnId: execution.turnId,
    executionId: execution.id,
    ticker: execution.ticker,
    executionStartedAt: '2026-09-19T00:00:00.000Z',
    finalizedAt,
    observations: observations(companyValue),
    materializedEvidenceIds: ['evidence-1'],
  });
}

describe('FinancialSnapshotStoreSqlite', () => {
  let db: FinharnessDatabase;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'finharness-financial-snapshot-'));
    db = openDb({ homeDir: dir });
  });

  afterEach(() => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a snapshot, resolves it by ID and Execution, and survives restart', async () => {
    const execution = await lifecycle(db);
    const created = await db.financialSnapshots.save(snapshot(execution));

    expect(created.snapshotId).toBe(snapshot(execution).snapshotId);
    expect(await db.financialSnapshots.getById(created.snapshotId)).toEqual(created);
    expect(await db.financialSnapshots.getByExecutionId(execution.id)).toEqual(created);
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM financial_snapshots').get() as { count: number }).count).toBe(1);

    db.raw.close();
    db = openDb({ homeDir: dir });
    expect(await db.financialSnapshots.getById(created.snapshotId)).toEqual(created);
    expect((await db.financialSnapshots.getByExecutionId(execution.id))?.observations[0]).toMatchObject({ kind: 'company_report', status: 'PRESENT' });
  });

  it('returns the immutable row for the same Execution and semantic payload', async () => {
    const execution = await lifecycle(db);
    const first = await db.financialSnapshots.save(snapshot(execution));
    const retry = await db.financialSnapshots.save(snapshot(execution, 1, '2026-09-19T02:01:00.000Z'));

    expect(retry).toEqual(first);
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM financial_snapshots').get() as { count: number }).count).toBe(1);
  });

  it('rejects a different canonical payload for the same Execution', async () => {
    const execution = await lifecycle(db);
    await db.financialSnapshots.save(snapshot(execution));

    await expect(db.financialSnapshots.save(snapshot(execution, 2))).rejects.toThrow(/conflict|immutable/i);
  });

  it('rejects cross-session and cross-turn linkage', async () => {
    const execution = await lifecycle(db);
    const other = await lifecycle(db, { sessionId: 'session-other', turnId: 'turn-other', executionId: 'run-other' });

    await expect(db.financialSnapshots.save(snapshot({ ...execution, sessionId: other.sessionId }))).rejects.toThrow(/session/i);
    await expect(db.financialSnapshots.save(snapshot({ ...execution, turnId: other.turnId }))).rejects.toThrow(/turn/i);
  });

  it('rejects an unknown or mismatched Execution linkage', async () => {
    const execution = await lifecycle(db);
    await expect(db.financialSnapshots.save(snapshot({ ...execution, id: 'run-missing' }))).rejects.toThrow(/execution/i);
    await db.sessions.settleExecution(execution.id, 'failed', { error: 'retry' });
    const second = await db.sessions.createExecution({ sessionId: execution.sessionId, turnId: execution.turnId, executionId: 'run-fs-2', ticker: 'BBCA', command: 'judge' });
    await expect(db.financialSnapshots.save(snapshot({ ...second, ticker: 'BBRI' }))).rejects.toThrow(/ticker/i);
  });

  it('creates a distinct identity for an identical payload in a new Execution', async () => {
    const execution = await lifecycle(db);
    const first = await db.financialSnapshots.save(snapshot(execution));
    await db.sessions.settleExecution(execution.id, 'failed', { error: 'retry' });
    const second = await db.sessions.createExecution({ sessionId: execution.sessionId, turnId: execution.turnId, executionId: 'run-fs-2', ticker: 'BBRI', command: 'judge' });

    const next = await db.financialSnapshots.save(snapshot(second));
    expect(next.snapshotId).not.toBe(first.snapshotId);
    expect(next.fingerprint).not.toBe(first.fingerprint);
  });

  it('applies migration 0012 without changing prior lifecycle rows', async () => {
    expect(db.raw.prepare("SELECT name FROM _migrations WHERE name = './0012_financial_snapshots.sql'").get()).toEqual({ name: './0012_financial_snapshots.sql' });
    expect(db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'financial_snapshots'").get()).toEqual({ name: 'financial_snapshots' });
  });

  it('upgrades a pre-0012 database and preserves existing Session rows', () => {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'finharness-financial-snapshot-legacy-'));
    const legacy = new Database(join(dir, 'finharness.db'));
    legacy.pragma('foreign_keys = OFF');
    legacy.exec('CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
    const priorMigrations = [
      './0001_initial.sql', './0002_normalized.sql', './0003_run_evidence.sql', './0004_evidence_hash_scoped.sql',
      './0005_research_sessions.sql', './0006_conversation_journal.sql', './0007_canonical_lifecycle.sql',
      './0008_session_working_context.sql', './0009_artifacts.sql', './0010_context_snapshots.sql', './0011_turn_model_calls.sql',
    ];
    for (const name of priorMigrations) {
      legacy.exec(readFileSync(new URL(`../src/migrations/${name.slice(2)}`, import.meta.url), 'utf8'));
      legacy.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    }
    legacy.prepare('INSERT INTO research_sessions (id, title, provider, model, reasoning_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('session_prior_n', 'Prior N migration', 'mock', 'mock', 'usual', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z');
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    db = openDb({ homeDir: dir });
    expect(db.raw.prepare("SELECT name FROM _migrations WHERE name = './0012_financial_snapshots.sql'").get())
      .toEqual({ name: './0012_financial_snapshots.sql' });
    expect(db.raw.prepare('SELECT id, title FROM research_sessions WHERE id = ?').get('session_prior_n'))
      .toEqual({ id: 'session_prior_n', title: 'Prior N migration' });
  }, 15_000);
});
