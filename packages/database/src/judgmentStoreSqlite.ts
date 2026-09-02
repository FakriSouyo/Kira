import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Orm } from './client';
import { judgments } from './schema';
import type { JudgmentStore, StoredJudgment } from '@harness/execution';
import type { Breakdown, Judgment } from '@harness/schemas';

interface JudgmentRow {
  id: string;
  runId: string;
  ticker: string;
  score: number;
  stance: string | null;
  confidence: string | null;
  breakdown: string;
  summary: string | null;
  createdAt: string;
}

function toStored(row: JudgmentRow): StoredJudgment {
  return {
    id: row.id,
    runId: row.runId,
    ticker: row.ticker,
    score: row.score,
    stance: row.stance as StoredJudgment['stance'],
    confidence: row.confidence as StoredJudgment['confidence'],
    breakdown: JSON.parse(row.breakdown) as Breakdown,
    summary: row.summary,
    createdAt: row.createdAt,
  };
}

/** Implementasi SQLite dari JudgmentStore (addendum §11/Task 14). */
export class JudgmentStoreSqlite implements JudgmentStore {
  constructor(private readonly db: Orm) {}

  async save(params: { runId: string; judgment: Judgment }): Promise<StoredJudgment> {
    const row: JudgmentRow = {
      id: randomUUID(),
      runId: params.runId,
      ticker: params.judgment.ticker,
      score: params.judgment.score,
      stance: params.judgment.stance,
      confidence: params.judgment.confidence,
      breakdown: JSON.stringify(params.judgment.breakdown),
      summary: params.judgment.summary,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(judgments).values(row);
    return toStored(row);
  }

  async getByRun(runId: string): Promise<StoredJudgment | null> {
    const rows = await this.db.select().from(judgments).where(eq(judgments.runId, runId)).limit(1);
    return rows.length > 0 ? toStored(rows[0] as JudgmentRow) : null;
  }
}
