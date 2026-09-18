import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import type {
  ModelCallRecord,
  ResearchExecution,
  ResearchSession,
  ResearchSessionArtifacts,
  ResearchSessionStore,
  ResearchTurn,
  WorkflowStepRecord,
} from '@harness/session-core';
import { transitionTurn } from '@harness/session-core';
import { ContextSnapshotIdSchema } from '@harness/context';
import type { Orm } from './client';
import { contextSnapshots, executions, modelCalls, researchSessions, researchTurns, workflowSteps } from './schema';

function toExecution(row: typeof executions.$inferSelect): ResearchExecution {
  if (row.sessionId === null || row.turnId === null || row.attempt === null) {
    throw new Error(`Execution ${row.id} is not linked to the canonical session lifecycle`);
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    attempt: row.attempt,
    ticker: row.ticker,
    command: row.command,
    status: row.status as ResearchExecution['status'],
    executionTime: row.executionTime,
    error: row.error,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

/** SQLite persistence for chat sessions, command turns, trace steps, and model calls. */
export class ResearchSessionStoreSqlite implements ResearchSessionStore {
  constructor(private readonly db: Orm) {}

  async createSession(params: Parameters<ResearchSessionStore['createSession']>[0]): Promise<ResearchSession> {
    const now = new Date().toISOString();
    const session: ResearchSession = {
      id: params.sessionId ?? `session_${randomUUID().slice(0, 8)}`,
      title: params.title,
      provider: params.provider,
      model: params.model,
      reasoningMode: params.reasoningMode,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(researchSessions).values(session);
    return session;
  }

  async createTurn(params: Parameters<ResearchSessionStore['createTurn']>[0]): Promise<ResearchTurn> {
    const turn: ResearchTurn = {
      id: params.turnId ?? `turn_${randomUUID().slice(0, 8)}`,
      sessionId: params.sessionId,
      runId: params.runId ?? null,
      input: params.input,
      command: params.command,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    return this.db.transaction((tx) => {
      if (params.runId) {
        const legacyRun = tx.select().from(executions).where(eq(executions.id, params.runId)).limit(1).get();
        if (!legacyRun) throw new Error(`Execution ${params.runId} not found`);
        if (legacyRun.turnId !== null || legacyRun.sessionId !== null || legacyRun.attempt !== null) {
          throw new Error(`Execution ${params.runId} already belongs to turn ${legacyRun.turnId ?? 'unknown'}`);
        }
      }
      tx.insert(researchTurns).values(turn).run();
      if (params.runId) {
        const linked = tx.update(executions).set({
          sessionId: turn.sessionId,
          turnId: turn.id,
          attempt: 1,
        }).where(and(
          eq(executions.id, params.runId),
          isNull(executions.sessionId),
          isNull(executions.turnId),
          isNull(executions.attempt),
        )).run();
        if (linked.changes !== 1) throw new Error(`Execution ${params.runId} was linked concurrently`);
      }
      tx.update(researchSessions).set({ updatedAt: turn.startedAt }).where(eq(researchSessions.id, turn.sessionId)).run();
      return turn;
    });
  }

  async settleTurn(...args: Parameters<ResearchSessionStore['settleTurn']>): Promise<ResearchTurn> {
    const [turnId, status, requestedAt] = args;
    return this.db.transaction((tx) => {
      const row = tx.select().from(researchTurns).where(eq(researchTurns.id, turnId)).limit(1).get();
      if (!row) throw new Error(`Turn ${turnId} not found`);
      const runningExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, turnId), eq(executions.status, 'running'))).limit(1).get();
      if (runningExecution) {
        throw new Error(`Turn ${turnId} cannot settle while execution ${runningExecution.id} is running`);
      }
      const settled = transitionTurn(row as ResearchTurn, status, requestedAt ?? new Date().toISOString());
      const updated = tx.update(researchTurns).set({ status: settled.status, completedAt: settled.completedAt })
        .where(and(eq(researchTurns.id, turnId), eq(researchTurns.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Turn ${turnId} did not settle atomically`);
      tx.update(researchSessions).set({ updatedAt: settled.completedAt ?? settled.startedAt })
        .where(eq(researchSessions.id, settled.sessionId)).run();
      return settled;
    });
  }

  async createExecution(params: Parameters<ResearchSessionStore['createExecution']>[0]): Promise<ResearchExecution> {
    return this.db.transaction((tx) => {
      const turn = tx.select().from(researchTurns).where(eq(researchTurns.id, params.turnId)).limit(1).get();
      if (!turn) throw new Error(`Turn ${params.turnId} not found`);
      if (turn.sessionId !== params.sessionId) {
        throw new Error(`Turn ${params.turnId} does not belong to session ${params.sessionId}`);
      }
      if (turn.status !== 'running') throw new Error(`Turn ${params.turnId} is already ${turn.status}`);
      const completedExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, params.turnId), eq(executions.status, 'completed'))).limit(1).get();
      if (completedExecution) throw new Error(`Turn ${params.turnId} already completed successfully`);
      const runningExecution = tx.select({ id: executions.id }).from(executions)
        .where(and(eq(executions.turnId, params.turnId), eq(executions.status, 'running'))).limit(1).get();
      if (runningExecution) throw new Error(`Turn ${params.turnId} already has a running execution`);
      const attemptRow = tx.select({ value: max(executions.attempt) }).from(executions)
        .where(eq(executions.turnId, params.turnId)).get();
      const now = new Date().toISOString();
      const execution: ResearchExecution = {
        id: params.executionId ?? `run_${randomUUID().slice(0, 8)}`,
        sessionId: params.sessionId,
        turnId: params.turnId,
        attempt: (attemptRow?.value ?? 0) + 1,
        ticker: params.ticker,
        command: params.command,
        status: 'running',
        executionTime: null,
        error: null,
        createdAt: now,
        completedAt: null,
      };
      tx.insert(executions).values(execution).run();
      tx.update(researchSessions).set({ updatedAt: now }).where(eq(researchSessions.id, params.sessionId)).run();
      return execution;
    });
  }

  async settleExecution(...args: Parameters<ResearchSessionStore['settleExecution']>): Promise<ResearchExecution> {
    const [executionId, status, result = {}] = args;
    return this.db.transaction((tx) => {
      const current = tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get();
      if (!current) throw new Error(`Execution ${executionId} not found`);
      if (current.status !== 'running') {
        throw new Error(`Execution ${executionId} is already ${current.status} — no further transitions allowed`);
      }
      const completedAt = result.completedAt ?? new Date().toISOString();
      const updated = tx.update(executions).set({
        status,
        executionTime: result.executionTimeSeconds ?? null,
        error: result.error ?? null,
        completedAt,
      }).where(and(eq(executions.id, executionId), eq(executions.status, 'running'))).run();
      if (updated.changes !== 1) throw new Error(`Execution ${executionId} did not settle atomically`);
      if (current.sessionId) {
        tx.update(researchSessions).set({ updatedAt: completedAt })
          .where(eq(researchSessions.id, current.sessionId)).run();
      }
      const settled = tx.select().from(executions).where(eq(executions.id, executionId)).limit(1).get();
      return toExecution(settled!);
    });
  }

  async saveStep(params: Parameters<ResearchSessionStore['saveStep']>[0]): Promise<WorkflowStepRecord> {
    const now = new Date().toISOString();
    const step: WorkflowStepRecord = {
      id: params.stepId ?? `step_${randomUUID().slice(0, 8)}`,
      runId: params.runId,
      nodeId: params.nodeId,
      parentNodeIds: params.parentNodeIds,
      subagent: params.subagent ?? null,
      skills: params.skills,
      status: params.status,
      durationMs: params.durationMs ?? null,
      summary: params.summary ?? null,
      error: params.error ?? null,
      createdAt: now,
      completedAt: params.status === 'running' ? null : now,
    };
    const stored = { ...step, parentNodeIds: JSON.stringify(step.parentNodeIds), skills: JSON.stringify(step.skills) };
    await this.db.insert(workflowSteps).values(stored).onConflictDoUpdate({
      target: [workflowSteps.runId, workflowSteps.nodeId],
      set: {
        parentNodeIds: stored.parentNodeIds,
        subagent: stored.subagent,
        skills: stored.skills,
        status: stored.status,
        durationMs: stored.durationMs,
        summary: stored.summary,
        error: stored.error,
        completedAt: stored.completedAt,
      },
    });
    const rows = await this.db.select().from(workflowSteps)
      .where(eq(workflowSteps.runId, params.runId));
    const row = rows.find((candidate) => candidate.nodeId === params.nodeId);
    if (!row) throw new Error(`Workflow step ${params.nodeId} was not persisted`);
    return {
      ...row,
      parentNodeIds: JSON.parse(row.parentNodeIds) as string[],
      skills: JSON.parse(row.skills) as WorkflowStepRecord['skills'],
    } as WorkflowStepRecord;
  }

  async recordModelCall(params: Parameters<ResearchSessionStore['recordModelCall']>[0]): Promise<ModelCallRecord> {
    const execution = await this.db.select().from(executions).where(eq(executions.id, params.runId)).limit(1);
    if (!execution[0]) throw new Error(`Execution ${params.runId} not found`);
    if (params.contextSnapshotId !== undefined && params.contextSnapshotId !== null) {
      ContextSnapshotIdSchema.parse(params.contextSnapshotId);
      const snapshot = await this.db.select().from(contextSnapshots)
        .where(eq(contextSnapshots.snapshotId, params.contextSnapshotId)).limit(1);
      if (!snapshot[0]) throw new Error(`ContextSnapshot ${params.contextSnapshotId} not found`);
      if (snapshot[0].sessionId !== execution[0].sessionId || snapshot[0].turnId !== execution[0].turnId) {
        throw new Error(`ContextSnapshot ${params.contextSnapshotId} session/turn does not belong to execution ${params.runId}`);
      }
    }
    const call: ModelCallRecord = {
      id: params.callId ?? `call_${randomUUID().slice(0, 8)}`,
      runId: params.runId,
      stepId: params.stepId,
      subagent: params.subagent,
      provider: params.provider,
      model: params.model,
      attempt: params.attempt,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cachedInputTokens: params.cachedInputTokens,
      totalTokens: params.totalTokens,
      latencyMs: params.latencyMs,
      finishReason: params.finishReason,
      contextSnapshotId: params.contextSnapshotId ?? null,
      cost: params.cost,
      currency: params.currency,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(modelCalls).values(call);
    return call;
  }

  async getSessionArtifacts(sessionId: string): Promise<ResearchSessionArtifacts> {
    const sessionRows = await this.db.select().from(researchSessions).where(eq(researchSessions.id, sessionId)).limit(1);
    if (!sessionRows[0]) throw new Error(`Session ${sessionId} not found`);
    const turns = await this.db.select().from(researchTurns).where(eq(researchTurns.sessionId, sessionId)).orderBy(asc(researchTurns.startedAt));
    const executionRows = await this.db.select().from(executions).where(eq(executions.sessionId, sessionId))
      .orderBy(asc(executions.createdAt), asc(executions.attempt));
    const sessionExecutions = executionRows.map(toExecution);
    const runIds = new Set(sessionExecutions.map((execution) => execution.id));
    const allSteps = await this.db.select().from(workflowSteps).orderBy(asc(workflowSteps.createdAt));
    const steps = allSteps.filter((step) => runIds.has(step.runId)).map((step) => ({
      ...step,
      parentNodeIds: JSON.parse(step.parentNodeIds) as string[],
      skills: JSON.parse(step.skills) as WorkflowStepRecord['skills'],
    })) as WorkflowStepRecord[];
    const allCalls = await this.db.select().from(modelCalls).orderBy(asc(modelCalls.createdAt));
    const calls = allCalls.filter((call) => runIds.has(call.runId)) as ModelCallRecord[];
    return {
      session: sessionRows[0] as ResearchSession,
      turns: turns as ResearchTurn[],
      executions: sessionExecutions,
      steps,
      modelCalls: calls,
    };
  }
}
