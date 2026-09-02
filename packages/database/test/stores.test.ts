import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-test-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openDb (addendum §10)', () => {
  it('membuat DB di direktori kustom dengan WAL mode', () => {
    const mode = db.raw.pragma('journal_mode', { simple: true });
    expect(mode).toBe('wal');
    expect(join(dir, 'finharness.db')).toBeTruthy();
  });

  it('membuat semua tabel dari migrasi', () => {
    const tables = (
      db.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['executions', 'evidence', 'agent_messages', 'claims', 'judgments']),
    );
  });

  it('migrasi idempotent — open kedua tidak error', () => {
    const second = openDb({ homeDir: dir });
    expect(second.raw.open).toBe(true);
    second.raw.close();
  });
});

describe('ExecutionStoreSqlite (Task 5)', () => {
  it('lifecycle: running → completed dengan execution time', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    expect(run.status).toBe('running');

    const done = await db.execution.completeRun(run.id, 12.3);
    expect(done.status).toBe('completed');
    expect(done.executionTime).toBe(12.3);
    expect(done.completedAt).toBeTruthy();
  });

  it('lifecycle: running → failed menyimpan error', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const failed = await db.execution.failRun(run.id, 'API_TIMEOUT');
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('API_TIMEOUT');
  });

  it('state machine: run terminal tidak bisa transisi lagi', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    await db.execution.completeRun(run.id, 1);
    await expect(db.execution.failRun(run.id, 'x')).rejects.toThrow(/already completed/);
  });

  it('getRun return null untuk run tak dikenal', async () => {
    expect(await db.execution.getRun('run_unknown')).toBeNull();
  });
});

describe('EvidenceStoreSqlite (Task 3)', () => {
  it('dedup: data sama (beda key order) di run berbeda → satu row evidence', async () => {
    const runA = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const runB = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });

    const e1 = await db.evidence.save({
      runId: runA.id,
      ticker: 'BBCA',
      source: 'sectors.company_report',
      data: { revenue: 100, profit: 20 },
    });
    const e2 = await db.evidence.save({
      runId: runB.id,
      ticker: 'BBCA',
      source: 'sectors.company_report',
      data: { profit: 20, revenue: 100 },
    });

    expect(e2.id).toBe(e1.id);
    const byTicker = await db.evidence.getByTicker('BBCA');
    expect(byTicker).toHaveLength(1);
  });

  it('getManyByIds mengembalikan evidence penuh dengan data ter-parse', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const saved = await db.evidence.save({
      runId: run.id,
      ticker: 'BBCA',
      source: 'sectors.company_report',
      data: { roe: 23.1 },
    });

    const [fetched] = await db.evidence.getManyByIds([saved.id]);
    expect(fetched.data).toEqual({ roe: 23.1 });
    expect(fetched.source).toBe('sectors.company_report');
  });

  it('getManyByIds dengan array kosong → []', async () => {
    expect(await db.evidence.getManyByIds([])).toEqual([]);
  });

  it('getByRun mengembalikan evidence milik run', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const other = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
    const e1 = await db.evidence.save({
      runId: run.id,
      ticker: 'BBCA',
      source: 'sectors.company_report',
      data: { roe: 23.1 },
    });
    await db.evidence.save({
      runId: other.id,
      ticker: 'BBRI',
      source: 'sectors.company_report',
      data: { roe: 20.3 },
    });

    const byRun = await db.evidence.getByRun(run.id);
    expect(byRun).toHaveLength(1);
    expect(byRun[0].id).toBe(e1.id);
  });
});

describe('ConversationStoreSqlite (Task 4)', () => {
  it('pesan ditambahkan acak → getByRun terurut sequence_order', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });

    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'judge_1',
      agent: 'judge',
      messageType: 'decision',
      content: 'Overall: BULLISH.',
      evidenceIds: [],
      sequenceOrder: 2,
    });
    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'researcher_1',
      agent: 'researcher',
      messageType: 'observation',
      content: 'Fetching Company Report…',
      evidenceIds: [],
      sequenceOrder: 0,
    });
    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'bull_1',
      agent: 'bull',
      messageType: 'claim',
      content: 'ROE 23.1% strong.',
      evidenceIds: ['evidence-uuid-1'],
      sequenceOrder: 1,
      metadata: { confidence: 'strong' },
    });

    const messages = await db.conversation.getByRun(run.id);
    expect(messages.map((m) => m.messageId)).toEqual(['researcher_1', 'bull_1', 'judge_1']);
    expect(messages[1].evidenceIds).toEqual(['evidence-uuid-1']);
    expect(messages[1].metadata).toEqual({ confidence: 'strong' });
  });

  it('getByAgent memfilter per agent', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'researcher_1',
      agent: 'researcher',
      messageType: 'observation',
      content: 'Fetching…',
      evidenceIds: [],
      sequenceOrder: 0,
    });
    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'bull_1',
      agent: 'bull',
      messageType: 'claim',
      content: 'Strong profitability.',
      evidenceIds: [],
      sequenceOrder: 1,
    });

    const bullOnly = await db.conversation.getByAgent(run.id, 'bull');
    expect(bullOnly).toHaveLength(1);
    expect(bullOnly[0].agent).toBe('bull');
  });

  it('UNIQUE(run_id, message_id) menolak duplikat', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const add = () =>
      db.conversation.addMessage({
        runId: run.id,
        messageId: 'bull_1',
        agent: 'bull',
        messageType: 'claim',
        content: 'Same message id.',
        evidenceIds: [],
        sequenceOrder: 0,
      });
    await add();
    await expect(add()).rejects.toThrow();
  });

  it('CHECK constraint menolak agent di luar enum', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    // better-sqlite3 melempar error sinkron, bukan rejected promise
    expect(() =>
      db.raw
        .prepare(
          "INSERT INTO agent_messages (id, run_id, message_id, agent, message_type, content, evidence_ids, sequence_order) VALUES ('x', ?, 'm1', 'analyst', 'claim', 'c', '[]', 0)",
        )
        .run(run.id),
    ).toThrow(/CHECK/);
  });
});
