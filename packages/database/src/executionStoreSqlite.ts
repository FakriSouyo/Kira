import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Orm } from './client';
import { executions } from './schema';
import type { ExecutionRun, ExecutionStore } from '@harness/execution';

interface ExecutionRow {
  id: string;
  ticker: string;
  command: string;
  status: string;
  executionTime: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

function toRun(row: ExecutionRow): ExecutionRun {
  return {
    id: row.id,
    ticker: row.ticker,
    command: row.command,
    status: row.status as ExecutionRun['status'],
    executionTime: row.executionTime,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** Implementasi SQLite dari ExecutionStore (addendum §11/Task 5) — state machine running → completed/failed. */
export class ExecutionStoreSqlite implements ExecutionStore {
  constructor(private readonly db: Orm) {}

  async createRun(params: {
    ticker: string;
    command: string;
    runId?: string;
  }): Promise<ExecutionRun> {
    const run: ExecutionRun = {
      id: params.runId ?? `run_${randomUUID().slice(0, 8)}`,
      ticker: params.ticker,
      command: params.command,
      status: 'running',
      executionTime: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    await this.db.insert(executions).values({
      id: run.id,
      ticker: run.ticker,
      command: run.command,
      status: run.status,
      createdAt: run.createdAt,
    });
    return run;
  }

  async completeRun(runId: string, executionTimeSeconds: number): Promise<ExecutionRun> {
    await this.assertRunning(runId);
    const completedAt = new Date().toISOString();
    await this.db
      .update(executions)
      .set({ status: 'completed', executionTime: executionTimeSeconds, completedAt })
      .where(eq(executions.id, runId));
    return (await this.getRun(runId))!;
  }

  async failRun(runId: string, errorMessage: string): Promise<ExecutionRun> {
    await this.assertRunning(runId);
    const completedAt = new Date().toISOString();
    await this.db
      .update(executions)
      .set({ status: 'failed', error: errorMessage, completedAt })
      .where(eq(executions.id, runId));
    return (await this.getRun(runId))!;
  }

  async getRun(runId: string): Promise<ExecutionRun | null> {
    const rows = await this.db.select().from(executions).where(eq(executions.id, runId)).limit(1);
    return rows.length > 0 ? toRun(rows[0] as ExecutionRow) : null;
  }

  private async assertRunning(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status !== 'running') {
      throw new Error(`Run ${runId} is already ${run.status} — no further transitions allowed`);
    }
  }
}
