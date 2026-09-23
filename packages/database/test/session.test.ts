import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import type { Claim, Judgment } from '@harness/schemas';
import { insertLegacyEvidenceFixture } from './helpers/legacyEvidenceFixture';

let db: FinharnessDatabase;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'finharness-session-test-'));
  db = openDb({ homeDir: dir });
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

const CLAIM: Claim = {
  claimId: 'claim_1',
  statement: 'Profitability remains strong.',
  confidence: 'strong',
  reasoning: 'ROE 23.1% indicates strong profitability.',
  evidenceIds: ['11111111-aaaa-4aaa-8aaa-111111111111'],
};

const JUDGMENT: Judgment = {
  ticker: 'BBCA',
  score: 72,
  stance: 'bullish',
  confidence: 'moderate',
  breakdown: { financialHealth: 80, growth: 65, valuation: 70, marketMomentum: null, risk: null },
  summary: 'Bullish stance.',
};

describe('Session helpers (Phase 2 Task 1)', () => {
  it('listRuns mengembalikan run terurut createdAt DESC', async () => {
    const runA = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    // ensure ordering by waiting 10ms
    await new Promise((r) => setTimeout(r, 10));
    const runB = await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });

    const listed = await db.execution.listRuns();
    expect(listed.map((r) => r.id)).toEqual([runB.id, runA.id]);
  });

  it('listRuns dengan limit/offset & filter ticker', async () => {
    await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    await db.execution.createRun({ ticker: 'BBRI', command: 'judge' });
    await db.execution.createRun({ ticker: 'BBCA', command: 'screen' });

    expect((await db.execution.listRuns({ limit: 2 })).length).toBe(2);
    expect((await db.execution.listRuns({ limit: 1, offset: 1 })).length).toBe(1);
    expect((await db.execution.listRuns({ ticker: 'BBCA' })).length).toBe(2);
  });

  it('getExecutionWithArtifacts mengembalikan evidence + messages + claims + judgment', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const ev = insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.company_report', data: { roe: 23.1 },
    });
    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'researcher_1',
      agent: 'researcher',
      messageType: 'observation',
      content: 'Fetching...',
      evidenceIds: [],
      sequenceOrder: 0,
    });
    await db.conversation.addMessage({
      runId: run.id,
      messageId: 'bull_1',
      agent: 'bull',
      messageType: 'claim',
      content: 'Strong.',
      evidenceIds: [ev.id],
      sequenceOrder: 1,
    });
    // Historical row fixture: the session projection reader must remain backward-compatible.
    db.raw.prepare(`INSERT INTO claims (id, run_id, message_id, claim_id, statement, confidence, reasoning, evidence_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`row_${run.id}`, run.id, 'bull_1', CLAIM.claimId,
      CLAIM.statement, CLAIM.confidence, CLAIM.reasoning, JSON.stringify([ev.id]));
    await db.judgments.save({ runId: run.id, judgment: JUDGMENT });
    await db.execution.completeRun(run.id, 1.2);

    const art = await db.execution.getExecutionWithArtifacts(run.id);
    expect(art.run.id).toBe(run.id);
    expect(art.evidence).toHaveLength(1);
    expect(art.evidence[0].id).toBe(ev.id);
    expect(art.messages).toHaveLength(2);
    expect(art.messages[0].messageId).toBe('researcher_1');
    expect(art.claims).toHaveLength(1);
    expect(art.claims[0].claimId).toBe('claim_1');
    expect(art.judgment).not.toBeNull();
    expect(art.judgment!.score).toBe(72);
  });

  it('getExecutionWithArtifacts untuk run tanpa judgment → judgment null', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    const art = await db.execution.getExecutionWithArtifacts(run.id);
    expect(art.judgment).toBeNull();
    expect(art.evidence).toEqual([]);
  });

  it('getExecutionWithArtifacts untuk run tak ada → NOT_FOUND', async () => {
    await expect(db.execution.getExecutionWithArtifacts('run_unknown')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('artifacts.evidence identik dgn getByRun — reuse toEvidence (Deviasi #19)', async () => {
    const run = await db.execution.createRun({ ticker: 'BBCA', command: 'judge' });
    insertLegacyEvidenceFixture(db.raw, {
      runId: run.id, ticker: 'BBCA', source: 'sectors.company_report',
      data: { financials: { roe: 23.1 }, overview: { market_cap: 1e15 } },
    });
    const art = await db.execution.getExecutionWithArtifacts(run.id);
    const byRun = await db.evidence.getByRun(run.id);
    expect(art.evidence).toEqual(byRun);
    expect(art.evidence[0].sourceType).toBe('api');
    expect(art.evidence[0].data).toEqual({ financials: { roe: 23.1 }, overview: { market_cap: 1e15 } });
  });
});
