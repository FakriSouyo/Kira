import { randomUUID } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import type { Orm } from './client';
import { agentMessages, claims, counterpoints as counterpointRows, evidence, executions, judgments, runEvidence } from './schema';
import type { ExecutionArtifacts, ExecutionRun, ExecutionStore } from '@harness/execution';
import { UserFriendlyError } from '@harness/shared';
// reuse pemetaan evidence terpusat (Deviasi #19) — hindari duplikasi snake→camel
import { type EvidenceRow, toEvidence } from './evidenceStoreSqlite';
import { toStoredClaim } from './claimStoreSqlite';
import { toStoredCounterpoint } from './counterpointStoreSqlite';

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

  async listRuns(params?: { limit?: number; offset?: number; ticker?: string }): Promise<ExecutionRun[]> {
    // drizzle where builder — ticker optional, ordered by createdAt DESC
    const base = this.db.select().from(executions).orderBy(desc(executions.createdAt), desc(executions.id));
    let rows: ExecutionRow[];
    if (params?.ticker) {
      rows = (await this.db
        .select()
        .from(executions)
        .where(eq(executions.ticker, params.ticker))
        .orderBy(desc(executions.createdAt), desc(executions.id))
        .limit(params.limit ?? 100)
        .offset(params.offset ?? 0)) as ExecutionRow[];
    } else {
      rows = (await base.limit(params?.limit ?? 100).offset(params?.offset ?? 0)) as ExecutionRow[];
    }
    return rows.map(toRun);
  }

  async getExecutionWithArtifacts(runId: string): Promise<ExecutionArtifacts> {
    const run = await this.getRun(runId);
    if (!run) {
      throw new UserFriendlyError('NOT_FOUND', `Run "${runId}" not found`, 'Try: /judge BBCA (or other valid ticker)');
    }
    const [evidenceRows, messageRows, claimRows, counterpointRowsForRun, judgmentRows] = await Promise.all([
      this.db.select({ evidence, membership: runEvidence }).from(runEvidence).innerJoin(evidence, eq(runEvidence.evidenceId, evidence.id)).where(eq(runEvidence.runId, runId)),
      this.db.select().from(agentMessages).where(eq(agentMessages.runId, runId)).orderBy(asc(agentMessages.sequenceOrder)),
      this.db.select().from(claims).where(eq(claims.runId, runId)).orderBy(asc(claims.claimId)),
      this.db.select().from(counterpointRows).where(eq(counterpointRows.runId, runId))
        .orderBy(asc(counterpointRows.sourceNodeId), asc(counterpointRows.counterpointId)),
      this.db.select().from(judgments).where(eq(judgments.runId, runId)).limit(1),
    ]);

    const evidenceArtifacts = evidenceRows.map((r) => toEvidence(r.evidence as EvidenceRow, r.membership));

    const messages = messageRows.map((r) => ({
      id: (r as { id: string }).id,
      runId: (r as { runId: string }).runId,
      messageId: (r as { messageId: string }).messageId,
      agent: (r as { agent: string }).agent as import('@harness/shared').AgentName,
      messageType: (r as { messageType: string }).messageType as import('@harness/shared').MessageType,
      content: (r as { content: string }).content,
      evidenceIds: JSON.parse((r as { evidenceIds: string }).evidenceIds) as string[],
      metadata: (r as { metadata: string | null }).metadata
        ? (JSON.parse((r as { metadata: string }).metadata) as Record<string, unknown>)
        : null,
      sequenceOrder: (r as { sequenceOrder: number }).sequenceOrder,
      createdAt: (r as { createdAt: string }).createdAt,
    })) as import('@harness/conversation').AgentMessage[];

    const storedClaims = claimRows.map(toStoredClaim);
    const storedCounterpoints = counterpointRowsForRun.map(toStoredCounterpoint);

    const judgment =
      judgmentRows.length > 0
        ? ({
            id: (judgmentRows[0] as { id: string }).id,
            runId: (judgmentRows[0] as { runId: string }).runId,
            ticker: (judgmentRows[0] as { ticker: string }).ticker,
            score: (judgmentRows[0] as { score: number }).score,
            stance: (judgmentRows[0] as { stance: string | null }).stance as import('@harness/execution').StoredJudgment['stance'],
            confidence: (judgmentRows[0] as { confidence: string | null }).confidence as import('@harness/execution').StoredJudgment['confidence'],
            breakdown: JSON.parse((judgmentRows[0] as { breakdown: string }).breakdown) as import('@harness/schemas').Breakdown,
            summary: (judgmentRows[0] as { summary: string | null }).summary,
            createdAt: (judgmentRows[0] as { createdAt: string }).createdAt,
          } as import('@harness/execution').StoredJudgment)
        : null;

    return { run, evidence: evidenceArtifacts, messages, claims: storedClaims, counterpoints: storedCounterpoints, judgment };
  }

  private async assertRunning(runId: string): Promise<void> {
    const run = await this.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status !== 'running') {
      throw new Error(`Run ${runId} is already ${run.status} — no further transitions allowed`);
    }
  }
}
