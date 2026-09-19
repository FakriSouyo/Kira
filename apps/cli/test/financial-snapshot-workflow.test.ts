import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type FinharnessDatabase } from '@harness/database';
import { buildContext } from '../src/context';
import { loadConfig } from '../src/config';
import { judgeWorkflow } from '../src/workflows/judgeWorkflow';

describe('/judge VerifiedFinancialSnapshot boundary', () => {
  let homeDir: string;
  let db: FinharnessDatabase;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'finharness-financial-snapshot-workflow-'));
    db = openDb({ homeDir });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.raw.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function lifecycle(ticker = 'BBCA') {
    const session = await db.sessions.createSession({
      title: 'Snapshot workflow', provider: 'mock', model: 'mock', reasoningMode: 'usual',
    });
    const turn = await db.sessions.createTurn({ sessionId: session.id, input: `/judge ${ticker}`, command: 'judge' });
    return { session, turn, ticker };
  }

  function context() {
    return buildContext(db, loadConfig({ homeDir, mockSectors: true, mockLlm: true }));
  }

  it('finalizes exactly one snapshot before the first Bull call and links accepted Evidence', async () => {
    const ctx = context();
    const ids = await lifecycle();
    const save = vi.spyOn(db.financialSnapshots, 'save');
    const bull = vi.spyOn(ctx.bull, 'analyze');

    const result = await judgeWorkflow(ctx, ids.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: ids.session.id, turnId: ids.turn.id },
    });
    const snapshot = await db.financialSnapshots.getByExecutionId(result.run.id);
    const evidenceIds = [...result.evidence, ...result.marketEvidence, ...result.newsEvidence].map(evidence => evidence.id);

    expect(save).toHaveBeenCalledTimes(1);
    expect(snapshot).toMatchObject({
      sessionId: ids.session.id,
      turnId: ids.turn.id,
      executionId: result.run.id,
      subject: { ticker: 'BBCA' },
      completeness: 'COMPLETE',
    });
    expect(snapshot?.materializedEvidenceIds).toEqual(evidenceIds);
    expect(snapshot?.observations).toHaveLength(7);
    expect(snapshot?.observations.every(observation => observation.status === 'PRESENT')).toBe(true);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(bull.mock.invocationCallOrder[0]!);
  });

  it('records optional provider failure as UNAVAILABLE without materializing optional Evidence', async () => {
    const ctx = context();
    const ids = await lifecycle('BBRI');
    vi.spyOn(ctx.financialData, 'getDailyTransaction').mockRejectedValue(new Error('market unavailable'));

    const result = await judgeWorkflow(ctx, ids.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: ids.session.id, turnId: ids.turn.id },
    });
    const snapshot = await db.financialSnapshots.getByExecutionId(result.run.id);
    const market = snapshot?.observations.filter(observation => observation.kind === 'daily_transaction' || observation.kind === 'foreign_flow');

    expect(result.run.status).toBe('completed');
    expect(result.marketEvidence).toEqual([]);
    expect(market).toEqual([
      { kind: 'daily_transaction', status: 'UNAVAILABLE', reason: 'PROVIDER_ERROR', errorCode: 'PROVIDER_ERROR' },
      { kind: 'foreign_flow', status: 'UNAVAILABLE', reason: 'PROVIDER_ERROR', errorCode: 'PROVIDER_ERROR' },
    ]);
    expect(snapshot?.completeness).toBe('PARTIAL');
  });

  it('records disabled enrichment as NOT_REQUESTED and makes no optional calls', async () => {
    const ctx = context();
    ctx.researchers.market = false;
    ctx.researchers.news = false;
    const ids = await lifecycle();
    const market = vi.spyOn(ctx.financialData, 'getDailyTransaction');
    const news = vi.spyOn(ctx.financialData, 'getNews');

    const result = await judgeWorkflow(ctx, ids.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: ids.session.id, turnId: ids.turn.id },
    });
    const snapshot = await db.financialSnapshots.getByExecutionId(result.run.id);

    expect(market).not.toHaveBeenCalled();
    expect(news).not.toHaveBeenCalled();
    expect(snapshot?.observations.filter(observation => observation.status === 'NOT_REQUESTED')).toHaveLength(5);
    expect(snapshot?.observations.filter(observation => observation.status === 'UNAVAILABLE')).toHaveLength(0);
  });

  it('preserves the original provider acquisition time when a later Execution reuses cached results', async () => {
    const ctx = context();
    const methods = [
      'getCompanyReport', 'getQuarterlyFinancials', 'getDailyTransaction',
      'getForeignFlow', 'getNews', 'getFilings', 'getSentiment',
    ] as const;
    let executionNumber = 0;
    for (const method of methods) {
      const original = ctx.financialData[method].bind(ctx.financialData);
      vi.spyOn(ctx.financialData, method).mockImplementation(async (ticker: string) => {
        const result = await original(ticker);
        return {
          ...result,
          metadata: {
            ...result.metadata,
            origin: executionNumber === 0 ? 'PROVIDER' : 'CACHE',
            fetchedAt: '2026-09-18T00:00:00.000Z',
          },
        };
      });
    }

    const firstIds = await lifecycle('BBCA');
    const first = await judgeWorkflow(ctx, firstIds.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: firstIds.session.id, turnId: firstIds.turn.id },
    });
    executionNumber = 1;
    const secondIds = await lifecycle('BBCA');
    const second = await judgeWorkflow(ctx, secondIds.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: secondIds.session.id, turnId: secondIds.turn.id },
    });

    const firstSnapshot = await db.financialSnapshots.getByExecutionId(first.run.id);
    const secondSnapshot = await db.financialSnapshots.getByExecutionId(second.run.id);
    expect(secondSnapshot?.snapshotId).not.toBe(firstSnapshot?.snapshotId);
    expect(secondSnapshot?.observations.filter(observation => observation.status === 'PRESENT')
      .every(observation => observation.metadata.fetchedAt === '2026-09-18T00:00:00.000Z')).toBe(true);
    expect(secondSnapshot?.executionStartedAt).not.toBe('2026-09-18T00:00:00.000Z');
    expect(new Date(secondSnapshot!.finalizedAt).getTime()).toBeGreaterThan(new Date('2026-09-18T00:00:00.000Z').getTime());
  });

  it('fails closed on a required ticker mismatch before Evidence or snapshot persistence', async () => {
    const ctx = context();
    const ids = await lifecycle();
    const original = await ctx.financialData.getCompanyReport(ids.ticker);
    vi.spyOn(ctx.financialData, 'getCompanyReport').mockResolvedValue({
      ...original,
      data: { ...original.data, ticker: 'BBRI' },
    });
    const bull = vi.spyOn(ctx.bull, 'analyze');

    await expect(judgeWorkflow(ctx, ids.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: ids.session.id, turnId: ids.turn.id },
    })).rejects.toMatchObject({ code: 'FINANCIAL_DATA_VERIFICATION_FAILED' });

    const run = db.raw.prepare('SELECT id FROM executions WHERE turn_id = ?').get(ids.turn.id) as { id: string };
    expect(await db.financialSnapshots.getByExecutionId(run.id)).toBeNull();
    expect((db.raw.prepare('SELECT COUNT(*) AS count FROM evidence WHERE run_id = ?').get(run.id) as { count: number }).count).toBe(0);
    expect(bull).not.toHaveBeenCalled();
  });

  it('keeps a finalized snapshot when reasoning fails afterward', async () => {
    const ctx = context();
    const ids = await lifecycle();
    vi.spyOn(ctx.bull, 'analyze').mockRejectedValue(new Error('bull unavailable'));

    await expect(judgeWorkflow(ctx, ids.ticker, () => {}, () => {}, {
      lifecycle: { sessionId: ids.session.id, turnId: ids.turn.id },
    })).rejects.toThrow('bull unavailable');

    const run = db.raw.prepare('SELECT id FROM executions WHERE turn_id = ?').get(ids.turn.id) as { id: string };
    expect(await db.financialSnapshots.getByExecutionId(run.id)).not.toBeNull();
    expect((db.raw.prepare('SELECT status FROM executions WHERE id = ?').get(run.id) as { status: string }).status).toBe('failed');
  });
});
